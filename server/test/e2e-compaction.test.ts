import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

/**
 * End-to-end compaction test with msw mocking the provider (OpenAI-compatible
 * /v1 endpoint) and the real server running in-process:
 * - starts the real server (imported, listening on a real port) with a small
 *   COMPACT_CONTEXT_WINDOW
 * - verifies normal turns (regression)
 * - verifies pre-turn + mid-turn compaction, summary re-injection, and the
 *   persisted 'compaction' records
 * - verifies overflow recovery directly through runAgentTurn
 *
 * msw intercepts the provider calls in-process; the test's own fetches to the
 * app API pass through (onUnhandledRequest: 'bypass').
 */

const APP_PORT = 3480;
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;
const MOCK_BASE = 'http://mock-provider.e2e/v1';
const MOCK_SUMMARY =
  '## Goal\nDo the test thing\n\n## Progress\n### Done\n- [x] echoed hello from the shell';

// ---------- msw-mocked provider ----------

let mockMode: 'normal' | 'error-once' | 'hang' = 'normal';
let errorOnceArmed = false;
let mockUsage = { prompt: 1234, completion: 56, total: 1290 };
let mockToolCommand = 'echo mock-hello';
const mockRequests: Record<string, unknown>[] = [];

/** True when the captured request is a compaction summarizer call. */
const isSummarizerReq = (r: Record<string, unknown>) => {
  const msgs = (r.messages ?? []) as { role?: string; content?: unknown }[];
  const system = msgs.find((m) => m.role === 'system');
  return system !== undefined && String(system.content ?? '').includes('context summarization assistant');
};

function sseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new HttpResponse(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

function sseChunks(text: string): unknown[] {
  const out: unknown[] = [
    { id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
  ];
  for (const piece of text.match(/.{1,24}/gs) ?? [])
    out.push({ id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece } }] });
  // Usage on the final chunk (stream_options.include_usage shape).
  out.push({
    id: 'm1',
    object: 'chat.completion.chunk',
    choices: [],
    usage: { prompt_tokens: mockUsage.prompt, completion_tokens: mockUsage.completion, total_tokens: mockUsage.total, prompt_tokens_details: { cached_tokens: 100 } },
  });
  out.push({ id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {} }] });
  return out;
}

/** A stream that emits partial text and then, after a short stall, ends
 * without a final/usage chunk (a stalled provider that disconnects). The
 * turn ends without a completed assistant call, so no usage is recorded.
 * (Deliberately not an abort: aborting an in-flight msw-intercepted
 * stream trips an undici assert in the mock's virtual socket teardown.) */
function hangResponse(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of ['par', 'tial'])
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece } }] })}\n\n`));
      setTimeout(() => controller.close(), 1200);
    },
  });
  return new HttpResponse(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

function streamToolCall(): unknown[] {
  return [
    { id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
    {
      id: 'm1',
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_mock_1',
                type: 'function',
                function: { name: 'bash', arguments: JSON.stringify({ command: mockToolCommand }) },
              },
            ],
          },
        },
      ],
    },
    {
      id: 'm1',
      object: 'chat.completion.chunk',
      choices: [],
      usage: { prompt_tokens: 234, completion_tokens: 12, total_tokens: 246 },
    },
    { id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {} }] },
  ];
}

const providerServer = setupServer(
  http.get(`${MOCK_BASE}/models`, () =>
    HttpResponse.json({
      data: [
        { id: 'mock-model-1' },
        { id: 'mock-model-1-2025-01-01' }, // dated snapshot of mock-model-1
        { id: 'mock-model-1:free' }, // service variant of mock-model-1
        { id: 'mock-model-2' },
      ],
    })
  ),
  http.post(`${MOCK_BASE}/chat/completions`, async ({ request }) => {
    const parsed = (await request.json()) as Record<string, unknown>;
    mockRequests.push(parsed);
    const messages = (parsed.messages ?? []) as { role: string; content?: unknown }[];
    const lastRole = messages[messages.length - 1]?.role;
    const hasToolResult = messages.some((m) => m.role === 'tool');

    // The compaction summarizer (identified by its prompt, streamed).
    if (isSummarizerReq(parsed)) {
      return sseResponse(sseChunks(MOCK_SUMMARY));
    }

    // A stream that never completes (stopped via the stop API).
    if (mockMode === 'hang') return hangResponse();

    // One-shot context-overflow error for the recovery test.
    if (mockMode === 'error-once' && errorOnceArmed) {
      errorOnceArmed = false;
      return HttpResponse.json(
        {
          error: {
            message: "This model's maximum context length is 100 tokens, but you requested 200",
            type: 'invalid_request_error',
          },
        },
        { status: 400 }
      );
    }

    return sseResponse(!hasToolResult && lastRole === 'user' ? streamToolCall() : sseChunks('done: mock replied'));
  })
);

// ---------- server under test (in-process) ----------

let app: { close: () => Promise<void> } | null = null;
let dataDir = '';
let workspace = '';

function post(path: string, body: unknown) {
  return fetch(`${APP_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface SseEvent {
  type: string;
  [k: string]: unknown;
}

async function streamTurn(sessionId: string, content: string): Promise<SseEvent[]> {
  const res = await fetch(`${APP_BASE}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  const events: SseEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)) as SseEvent);
  }
  return events;
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-h-e2e-data-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-h-e2e-ws-'));
  // The env window is deliberately huge: compaction in this test must come
  // from the per-model context window configured on the provider, not from
  // the env fallback. Set before the import: the server reads these at
  // module load.
  process.env.PORT = String(APP_PORT);
  process.env.WEBUI_H_DATA_DIR = dataDir;
  process.env.AGENT_WORKSPACE_DIR = workspace;
  process.env.COMPACT_CONTEXT_WINDOW = '100000';
  process.env.COMPACT_RESERVE_TOKENS = '2000';
  process.env.COMPACT_KEEP_RECENT_TOKENS = '1000';
  process.env.OPENAI_API_KEY = ''; // no .env import of a real provider
  providerServer.listen({ onUnhandledFrame: 'bypass' });
  const mod = await import('../src/index');
  app = mod.app;
  // Wait for /api/health.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${APP_BASE}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 300));
  }
});

test.after(async () => {
  await app?.close();
  providerServer.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('e2e: normal turn, pre-turn compaction, mid-turn compaction, overflow recovery', { timeout: 120_000 }, async (t) => {
  // Setup: provider + project + session.
  const prov = await post('/api/providers', { name: 'mock', baseUrl: MOCK_BASE, apiKey: 'k', isDefault: true });
  assert.equal(prov.status, 201);
  const provId = (await prov.json()).id as string;

  await t.test('per-model context window round-trips through the provider API', async () => {
    const patch = await fetch(`${APP_BASE}/api/providers/${provId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelContextWindows: { 'mock-model-1': 5000 } }),
    });
    assert.equal(patch.status, 200);
    const providers = await fetch(`${APP_BASE}/api/providers`).then(
      (r) =>
        r.json() as {
          models: { id: string; contextWindow?: number }[];
          model_groups: { id: string; aliases: string[]; contextWindow?: number }[];
        }[]
    );
    const prov = providers.find((p) => p.id === provId)!;
    const model = prov.models.find((m) => m.id === 'mock-model-1');
    assert.equal(model?.contextWindow, 5000);

    // Aliases/snapshots are collapsed into base-model groups, canonical id first.
    assert.deepEqual(prov.model_groups, [
      { id: 'mock-model-1', aliases: ['mock-model-1-2025-01-01', 'mock-model-1:free'], contextWindow: 5000 },
      { id: 'mock-model-2', aliases: [] },
    ]);

    // Invalid values are rejected.
    const bad = await fetch(`${APP_BASE}/api/providers/${provId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelContextWindows: { 'mock-model-1': -1 } }),
    });
    assert.equal(bad.status, 400);
  });

  const proj = await post('/api/projects', { name: 'e2e', cwd: workspace });
  assert.equal(proj.status, 201);
  const sess = await post('/api/sessions', { projectId: (await proj.json()).id });
  assert.equal(sess.status, 201);
  const sessionId = (await sess.json()).id as string;

  await t.test('normal turn works and persists user/assistant/tool rows', async () => {
    const events = await streamTurn(sessionId, 'say hello with the shell');
    const types = events.map((e) => e.type);
    assert.ok(types.includes('tool.start'));
    assert.ok(types.includes('tool.result'));
    const complete = events.find((e) => e.type === 'message.complete');
    assert.ok(complete, 'expected message.complete');
    assert.ok(String(complete!.content).includes('done: mock replied'));
    assert.ok(!types.includes('compaction'), 'small context must not compact');

    // Context usage is reported: a context event per LLM call with the
    // per-model window, and the final estimate on the complete event.
    const ctx = events.filter((e) => e.type === 'context');
    assert.ok(ctx.length >= 1, 'expected context events');
    assert.ok(typeof ctx[0]!.tokens === 'number' && ctx[0]!.tokens > 0);
    assert.equal(ctx[0]!.window, 5000); // per-model window configured above
    assert.equal(ctx[0]!.threshold, 3000); // window - reserve(2000)
    assert.ok(typeof complete!.tokens === 'number' && complete!.tokens > 0);

    const s = await fetch(`${APP_BASE}/api/sessions/${sessionId}`).then((r) => r.json() as { messages: { role: string; meta: string | null }[] });
    assert.deepEqual(s.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
    // Usage round-trip: the mock's usage chunk is captured, persisted on the
    // tool.round record, and read back from the session.
    const toolRound = s.messages[1]!;
    const meta = JSON.parse(toolRound.meta!) as { usage?: { input: number; output: number } };
    assert.deepEqual(meta.usage, { input: 234, output: 12, totalTokens: 246 });
  });

  await t.test('large context triggers pre-turn compaction and the summary is re-injected', async () => {
    mockRequests.length = 0;
    const big = 'x'.repeat(16_000); // ~4000 tokens by the chars/4 estimate
    const events = await streamTurn(sessionId, big);
    const types = events.map((e) => e.type);
    assert.ok(types.includes('compaction'), `expected compaction, got: ${types.join(',')}`);
    // Live compaction events: start, (throttled) progress, then the end.
    const sIdx = types.indexOf('compaction.start');
    const pIdx = types.indexOf('compaction.progress');
    const eIdx = types.indexOf('compaction');
    assert.ok(sIdx !== -1 && eIdx !== -1, `expected compaction.start/end, got: ${types.join(',')}`);
    assert.ok(sIdx < eIdx, 'start before end');
    assert.ok(pIdx !== -1 && sIdx < pIdx && pIdx < eIdx, 'progress between start and end');
    const endEv = events.find((e) => e.type === 'compaction') as { summary?: unknown };
    assert.ok(String(endEv.summary ?? '').includes('## Goal'), 'end event carries the produced summary');
    // The summarizer request received the serialized span.
    const summaryReq = mockRequests.find((r) => isSummarizerReq(r));
    assert.ok(summaryReq, 'expected a summarizer call');
    const reqUser = (summaryReq!.messages as { content?: string }[])[1]!;
    assert.ok(String(reqUser.content).includes('[User]:'), 'serialized span should use [User] labels');
    assert.ok(String(reqUser.content).includes('echo mock-hello'));
    // The final streaming request contains the summary as a user message and
    // does NOT contain the summarized small rows... but it does contain the
    // large user message (it is the kept tail).
    const streamReqs = mockRequests.filter((r) => r.stream === true);
    const lastStream = streamReqs[streamReqs.length - 1]! as { messages: { content?: string | null }[] };
    const summaryMsg = lastStream.messages.find((m) => String(m.content ?? '').startsWith('CONTEXT SUMMARY'));
    assert.ok(summaryMsg, 'expected CONTEXT SUMMARY message in the request');
    assert.ok(String(summaryMsg!.content).includes('Do the test thing'));
    assert.ok(lastStream.messages.some((m) => String(m.content ?? '').includes('x'.repeat(1000))));

    // The turn still completed through the tools.
    const complete = events.find((e) => e.type === 'message.complete');
    assert.ok(complete && String(complete.content).includes('done: mock replied'));

    // History now holds compaction record(s).
    const s = await fetch(`${APP_BASE}/api/sessions/${sessionId}`).then((r) => r.json() as { messages: { role: string }[] });
    const roles = s.messages.map((m) => m.role);
    assert.ok(roles.includes('compaction'), `history should include compaction: ${roles.join(',')}`);
    // The pre-turn compaction record is appended right after the large user
    // message (append-only order): [..., user(big), compaction, ...].
    const firstCompaction = roles.indexOf('compaction');
    const bigUserIdx = roles.lastIndexOf('user');
    assert.equal(firstCompaction, bigUserIdx + 1, roles.join(','));
  });

  await t.test('subsequent turn sees only summary + kept tail (no summarized rows)', async () => {
    mockRequests.length = 0;
    const events = await streamTurn(sessionId, 'and now finish');
    const complete = events.find((e) => e.type === 'message.complete');
    assert.ok(complete && String(complete.content).includes('done: mock replied'));
    const streamReqs = mockRequests.filter((r) => r.stream === true && !isSummarizerReq(r));
    assert.ok(streamReqs.length >= 1);
    const req = streamReqs[0]! as { messages: { content?: string | null }[] };
    assert.ok(req.messages.some((m) => String(m.content ?? '').startsWith('CONTEXT SUMMARY')));
    // The 16k-char message must be gone unless it is still inside the kept
    // tail; here the tail kept it in the previous turn, so check the first
    // message is the summary and no pre-compaction rows leaked: the original
    // 'say hello with the shell' row must not appear verbatim.
    assert.ok(!req.messages.some((m) => String(m.content ?? '').includes('say hello with the shell')));
  });
});

test('e2e: overflow recovery compacts once and retries the step', { timeout: 60_000 }, async () => {
  // Same in-process module: the compaction constants were loaded with the
  // env set in test.before (reserve 2000, keep-recent 1000).
  const { runAgentTurn } = await import('../src/agent');

  mockMode = 'error-once';
  errorOnceArmed = true;
  mockRequests.length = 0;

  // ~3000 tokens: under the 3000 threshold for mid-turn compaction (the
  // check only runs after a tool round), but big enough that the recovery
  // cut point leaves a non-empty span to summarize.
  const messages = [
    { role: 'user' as const, content: 'a'.repeat(6000), seq: 1 },
    { role: 'assistant' as const, content: 'ok', seq: 2 },
    { role: 'user' as const, content: 'b'.repeat(6000), seq: 3 },
    { role: 'assistant' as const, content: 'ok', seq: 4 },
    { role: 'user' as const, content: 'go', seq: 5 },
  ];
  const events: { type: string; [k: string]: unknown }[] = [];
  for await (const ev of runAgentTurn({
    messages,
    workspace,
    model: 'mock-model-1',
    provider: { baseUrl: MOCK_BASE, apiKey: 'k' },
  })) {
    events.push(ev as { type: string; [k: string]: unknown });
  }

  const types = events.map((e) => e.type);
  assert.ok(types.includes('compaction'), `expected compaction from overflow recovery: ${types.join(',')}`);
  const complete = events.find((e) => e.type === 'message.complete');
  assert.ok(complete, 'turn should complete after recovery');
  assert.ok(String(complete!.content).includes('done: mock replied'));
  assert.ok(types.includes('error') === false, 'no error event expected');

  // The first streaming request failed with a 400 context error, then a
  // summarizer call happened, then the retried stream.
  const summaryReq = mockRequests.find((r) => isSummarizerReq(r));
  assert.ok(summaryReq, 'recovery must call the summarizer');
  mockMode = 'normal';
});

test('e2e: stale usage after a stalled turn does not re-trigger compaction (pi staleness guard)', { timeout: 120_000 }, async () => {
  // Fresh session; same provider (mock-model-1: window 5000, reserve 2000 ->
  // threshold 3000, keep-recent 1000).
  const proj = await post('/api/projects', { name: 'e2e-stale', cwd: workspace });
  assert.equal(proj.status, 201);
  const sess = await post('/api/sessions', { projectId: (await proj.json()).id });
  assert.equal(sess.status, 201);
  const sessionId = (await sess.json()).id as string;

  // Turn A: a big tool result (~1250 tokens, above the keep-recent budget)
  // and a large reported usage (4500 > threshold 3000). No compaction fires
  // (total ~1350 < 3000); the turn completes, leaving a fresh 4500 anchor.
  mockUsage = { prompt: 4400, completion: 100, total: 4500 };
  mockToolCommand = "head -c 5000 /dev/zero | tr '\\0' 'y'";
  const a = await streamTurn(sessionId, 'run a big command');
  const aComplete = a.find((e) => e.type === 'message.complete');
  assert.ok(aComplete, 'turn A completes');
  assert.ok(!a.some((e) => e.type === 'compaction'), 'turn A must not compact (~1350 < 3000)');

  // Turn B: the pre-turn check sees the fresh 4500 anchor -> compaction
  // (the span is the pre-budget prefix). Then the LLM call stalls and the
  // stream ends without a final/usage chunk, so no post-compaction usage
  // is recorded. The newest usage in history is now the stale
  // pre-compaction 4500 anchor.
  mockMode = 'hang';
  const bEvents = await streamTurn(sessionId, 'hang');
  assert.ok(bEvents.some((e) => e.type === 'compaction'), 'turn B pre-turn compaction');
  const bEnd = bEvents.find((e) => e.type === 'message.complete');
  assert.ok(bEnd, 'turn B ends (stalled stream, clean end)');
  assert.equal(String(bEnd!.content), 'partial', 'the stalled stream delivered only its partial text');
  mockMode = 'normal';
  mockUsage = { prompt: 1234, completion: 56, total: 1290 };
  mockToolCommand = 'echo mock-hello';

  // Turn C: without the guard, the stale 4500 anchor would re-trigger the
  // pre-turn compaction. With it, the pure estimate (summary + small kept
  // tail) is under the threshold: no compaction, turn completes.
  mockRequests.length = 0;
  const c = await streamTurn(sessionId, 'ok');
  const cComplete = c.find((e) => e.type === 'message.complete');
  assert.ok(cComplete, 'turn C completes');
  assert.ok(!c.some((e) => e.type === 'compaction'), 'turn C must not re-compact on the stale anchor');
  assert.ok(!mockRequests.some(isSummarizerReq), 'no summarizer call in turn C');

  // The on-load context bar uses the same guard: the reported size is the
  // pure estimate (well under the threshold), not the stale 4500 anchor.
  const s = await fetch(`${APP_BASE}/api/sessions/${sessionId}`).then(
    (r) => r.json() as { context: { tokens: number; threshold: number } | null }
  );
  assert.ok(s.context, 'context reported on load');
  assert.ok(s.context!.tokens < s.context!.threshold, `on-load tokens ${s.context!.tokens} must be under the ${s.context!.threshold} threshold`);
});
