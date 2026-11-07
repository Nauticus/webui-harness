import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * End-to-end compaction test with a mock OpenAI-compatible provider:
 * - spawns the real server (tsx) with a small COMPACT_CONTEXT_WINDOW
 * - verifies normal turns (regression)
 * - verifies pre-turn + mid-turn compaction, summary re-injection, and the
 *   persisted 'compaction' records
 * - verifies overflow recovery directly through runAgentTurn
 */

const MOCK_PORT = 3479;
const APP_PORT = 3480;
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;
const MOCK_SUMMARY =
  '## Goal\nDo the test thing\n\n## Progress\n### Done\n- [x] echoed hello from the shell';

// ---------- mock provider ----------

let mockMode: 'normal' | 'error-once' = 'normal';
let errorOnceArmed = false;
const mockRequests: unknown[] = [];

function sseWrite(res: http.ServerResponse, obj: unknown) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function streamToolCall(res: http.ServerResponse) {
  const chunk = (delta: unknown) =>
    sseWrite(res, { id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] });
  chunk({ role: 'assistant', content: '' });
  chunk({
    tool_calls: [
      {
        index: 0,
        id: 'call_mock_1',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"echo mock-hello"}' },
      },
    ],
  });
  chunk({});
  res.write('data: [DONE]\n\n');
  res.end();
}

function streamText(res: http.ServerResponse, text: string) {
  const chunk = (delta: unknown) =>
    sseWrite(res, { id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] });
  chunk({ role: 'assistant', content: '' });
  chunk({ content: text });
  chunk({});
  res.write('data: [DONE]\n\n');
  res.end();
}

const mock = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        data: [
          { id: 'mock-model-1' },
          { id: 'mock-model-1-2025-01-01' }, // dated snapshot of mock-model-1
          { id: 'mock-model-1:free' }, // service variant of mock-model-1
          { id: 'mock-model-2' },
        ],
      })
    );
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/requests') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(mockRequests));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      mockRequests.push(parsed);
      const messages = (parsed.messages ?? []) as { role: string }[];
      const lastRole = messages[messages.length - 1]?.role;
      const hasToolResult = messages.some((m) => m.role === 'tool');

      // Non-streaming call = the compaction summarizer.
      if (parsed.stream !== true) {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            id: 'm1',
            object: 'chat.completion',
            model: parsed.model,
            choices: [{ index: 0, message: { role: 'assistant', content: MOCK_SUMMARY }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
        return;
      }

      // One-shot context-overflow error for the recovery test.
      if (mockMode === 'error-once' && errorOnceArmed) {
        errorOnceArmed = false;
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: {
              message: 'This model\'s maximum context length is 100 tokens, but you requested 200',
              type: 'invalid_request_error',
            },
          })
        );
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      if (!hasToolResult && lastRole === 'user') streamToolCall(res);
      else streamText(res, 'done: mock replied');
    });
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

// ---------- server under test ----------

let app: ChildProcess;
let dataDir: string;
let workspace: string;

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
  await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weblisan-e2e-data-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'weblisan-e2e-ws-'));
  app = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.resolve(new URL('..', import.meta.url).pathname),
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      WEBLISAN_DATA_DIR: dataDir,
      // The env window is deliberately huge: compaction in this test must
      // come from the per-model context window configured on the provider,
      // not from the env fallback.
      COMPACT_CONTEXT_WINDOW: '100000',
      COMPACT_RESERVE_TOKENS: '2000',
      COMPACT_KEEP_RECENT_TOKENS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout?.on('data', (d: Buffer) => process.env.WEBLISAN_E2E_DEBUG && process.stderr.write(`[app] ${d}`));
  app.stderr?.on('data', (d: Buffer) => process.env.WEBLISAN_E2E_DEBUG && process.stderr.write(`[app!] ${d}`));
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
  app?.kill();
  await new Promise((r) => setTimeout(r, 200));
  mock.close();
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

    const s = await fetch(`${APP_BASE}/api/sessions/${sessionId}`).then((r) => r.json() as { messages: { role: string }[] });
    assert.deepEqual(s.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  });

  await t.test('large context triggers pre-turn compaction and the summary is re-injected', async () => {
    mockRequests.length = 0;
    const big = 'x'.repeat(16_000); // ~4000 tokens by the chars/4 estimate
    const events = await streamTurn(sessionId, big);
    const types = events.map((e) => e.type);
    assert.ok(types.includes('compaction'), `expected compaction, got: ${types.join(',')}`);
    // The summarizer (non-streaming) request received the serialized span.
    const summaryReq = mockRequests.find((r) => (r as { stream?: unknown }).stream !== true);
    assert.ok(summaryReq, 'expected a non-streaming summarizer call');
    const reqUser = (summaryReq as { messages: { content?: string }[] }).messages[1]!;
    assert.ok(String(reqUser.content).includes('[User]:'), 'serialized span should use [User] labels');
    assert.ok(String(reqUser.content).includes('echo mock-hello'));
    // The final streaming request contains the summary as a user message and
    // does NOT contain the summarized small rows... but it does contain the
    // large user message (it is the kept tail).
    const streamReqs = mockRequests.filter((r) => (r as { stream?: unknown }).stream === true);
    const lastStream = streamReqs[streamReqs.length - 1] as { messages: { content?: string | null }[] };
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
    const streamReqs = mockRequests.filter((r) => (r as { stream?: unknown }).stream === true);
    assert.ok(streamReqs.length >= 1);
    const req = streamReqs[0] as { messages: { content?: string | null }[] };
    assert.ok(req.messages.some((m) => String(m.content ?? '').startsWith('CONTEXT SUMMARY')));
    // The 16k-char message must be gone unless it is still inside the kept
    // tail; here the tail kept it in the previous turn, so check the first
    // message is the summary and no pre-compaction rows leaked: the original
    // 'say hello with the shell' row must not appear verbatim.
    assert.ok(!req.messages.some((m) => String(m.content ?? '').includes('say hello with the shell')));
  });
});

test('e2e: overflow recovery compacts once and retries the step', { timeout: 60_000 }, async () => {
  // Import the agent module with the small compaction threshold env.
  process.env.COMPACT_CONTEXT_WINDOW = '5000';
  process.env.COMPACT_RESERVE_TOKENS = '2000';
  process.env.COMPACT_KEEP_RECENT_TOKENS = '1000';
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
  // non-streaming summarizer call happened, then the retried stream.
  const summaryReq = mockRequests.find((r) => (r as { stream?: unknown }).stream !== true);
  assert.ok(summaryReq, 'recovery must call the summarizer');
  mockMode = 'normal';
});
