import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

/**
 * The manual compaction endpoint: POST /api/sessions/:id/compact.
 *
 * It has to behave like the pre-turn compaction a long session triggers by
 * itself — same events, same persisted record — without running a turn, refuse
 * while a turn owns the history, and refuse when there is nothing to summarize
 * instead of spending a model call to find that out.
 */

const APP_PORT = 3493;
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;
const MOCK_BASE = 'http://mock-compact.e2e/v1';
const MOCK_SUMMARY = '## Goal\nCompact on demand\n\n## Progress\n### Done\n- [x] wrote the test history';

const isSummarizerReq = (r: Record<string, unknown>) => {
  const msgs = (r.messages ?? []) as { role?: string; content?: unknown }[];
  const system = msgs.find((m) => m.role === 'system');
  return system !== undefined && String(system.content ?? '').includes('context summarization assistant');
};

let hang = false;
let summarizerCalls = 0;

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
  for (const piece of text.match(/.{1,64}/gs) ?? [])
    out.push({ id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece } }] });
  out.push({ id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {} }], finish_reason: 'stop' });
  return out;
}

const providerServer = setupServer(
  http.get(`${MOCK_BASE}/models`, () => HttpResponse.json({ data: [{ id: 'mock-model-1' }] })),
  http.post(`${MOCK_BASE}/chat/completions`, async ({ request }) => {
    const parsed = (await request.json()) as Record<string, unknown>;
    if (isSummarizerReq(parsed)) {
      summarizerCalls++;
      return sseResponse(sseChunks(MOCK_SUMMARY));
    }
    if (hang) {
      // A stream that stays open, so a turn is provably running. The close is
      // guarded and the timer cleared on cancel: this stream outlives the test
      // that started it (the turn is stopped), and an unguarded close after
      // that surfaces as an assertion in the mock's socket teardown.
      const encoder = new TextEncoder();
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(t);
        try {
          streamController?.close();
        } catch {
          /* already torn down */
        }
      };
      let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
      let t = setTimeout(close, 1200);
      return new HttpResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'working' } }] })}\n\n`
              )
            );
          },
          cancel: close,
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
    }
    return sseResponse(sseChunks('reply: ' + 'word '.repeat(120)));
  })
);

let app: { close: () => Promise<void> } | null = null;
let dataDir = '';
let workspace = '';

async function post(pathname: string, body?: unknown) {
  return fetch(`${APP_BASE}${pathname}`, {
    method: 'POST',
    // No body, no content-type: Fastify rejects an empty body that claims to
    // be JSON, and the compact route has no body at all.
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface SseEvent {
  type: string;
  [k: string]: unknown;
}

/** Consume an SSE response into events. */
async function events(res: Response): Promise<SseEvent[]> {
  const text = await res.text();
  const out: SseEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) out.push(JSON.parse(line.slice(6)) as SseEvent);
  }
  return out;
}

const sendTurn = async (sessionId: string, content: string) =>
  events(await post(`/api/sessions/${sessionId}/messages`, { content }));

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-h-compact-data-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-h-compact-ws-'));
  process.env.PORT = String(APP_PORT);
  process.env.WEBUI_H_DATA_DIR = dataDir;
  process.env.AGENT_WORKSPACE_DIR = workspace;
  // Small window, small keep-recent budget: a few turns are enough to have an
  // older half worth summarizing.
  process.env.COMPACT_CONTEXT_WINDOW = '60000';
  process.env.COMPACT_RESERVE_TOKENS = '2000';
  process.env.COMPACT_KEEP_RECENT_TOKENS = '600';
  process.env.OPENAI_API_KEY = '';
  providerServer.listen({ onUnhandledRequest: 'bypass' });
  const mod = await import('../src/index');
  app = mod.app;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${APP_BASE}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
});

test.after(async () => {
  await app?.close();
  providerServer.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

let sessionId = '';

test('compact route: setup — provider, project, session, a few turns', { timeout: 60_000 }, async () => {
  const prov = await post('/api/providers', { name: 'mock', baseUrl: MOCK_BASE, apiKey: 'k', isDefault: true });
  assert.equal(prov.status, 201);
  const proj = await post('/api/projects', { name: 'p', cwd: workspace });
  assert.equal(proj.status, 201);
  const sess = await post('/api/sessions', { projectId: (await proj.json()).id, model: 'mock-model-1' });
  assert.equal(sess.status, 201);
  sessionId = (await sess.json()).id as string;

  for (let i = 0; i < 4; i++) {
    const evs = await sendTurn(sessionId, `turn ${i}: ` + 'filler '.repeat(150));
    assert.ok(evs.some((e) => e.type === 'message.complete'), `turn ${i} did not complete`);
  }
});

test('unknown session is a 404', async () => {
  const res = await post('/api/sessions/00000000-0000-4000-8000-000000000000/compact');
  assert.equal(res.status, 404);
});

test('compacting a session with nothing to summarize is refused before any model call', async () => {
  const proj = await post('/api/projects', { name: 'tiny', cwd: workspace });
  const sess = await post('/api/sessions', { projectId: (await proj.json()).id, model: 'mock-model-1' });
  const id = (await sess.json()).id as string;
  await sendTurn(id, 'one small question');

  const before = summarizerCalls;
  const res = await post(`/api/sessions/${id}/compact`);
  assert.equal(res.status, 400);
  assert.match(String((await res.json()).error), /nothing to compact/);
  assert.equal(summarizerCalls, before, 'refusal must not spend a summarizer call');
});

test('manual compaction streams the compaction card events and persists the record', { timeout: 60_000 }, async () => {
  const before = await (await fetch(`${APP_BASE}/api/sessions/${sessionId}`)).json();
  const tokensBefore = (before.context as { tokens: number }).tokens;
  const summarizerBefore = summarizerCalls;

  const res = await post(`/api/sessions/${sessionId}/compact`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const evs = await events(res);

  const start = evs.find((e) => e.type === 'compaction.start');
  const done = evs.find((e) => e.type === 'compaction');
  const ctx = evs.find((e) => e.type === 'context');
  assert.ok(start, 'no compaction.start');
  assert.ok(done, 'no compaction event');
  assert.equal(evs.some((e) => e.type === 'error'), false, 'compaction must not error');
  assert.equal(summarizerCalls, summarizerBefore + 1, 'exactly one summarizer call');
  assert.equal(typeof done!.tokensBefore, 'number');
  assert.equal(typeof done!.tokensAfter, 'number');
  assert.ok(String(done!.summary).includes('Compact on demand'), 'summary is the summarizer output');

  // The readout must come down afterwards, smaller than before.
  assert.ok(ctx, 'no refreshed context event');
  assert.ok(
    (ctx as unknown as { tokens: number }).tokens < tokensBefore,
    'compaction did not shrink the context'
  );

  // And it survived: a compaction record is the new boundary.
  const after = await (await fetch(`${APP_BASE}/api/sessions/${sessionId}`)).json();
  const rows = after.messages as { role: string; meta: string | null }[];
  const rec = rows.filter((r) => r.role === 'compaction');
  assert.equal(rec.length, 1, 'expected one persisted compaction record');
  assert.ok(JSON.parse(String(rec[0]!.meta)).firstKeptSeq !== undefined, 'record carries the boundary');
  assert.ok((after.context as { tokens: number }).tokens < tokensBefore, 'reload shows the smaller context');
});

test('compaction refuses while a turn owns the session', { timeout: 60_000 }, async () => {
  hang = true;
  const running = await post(`/api/sessions/${sessionId}/messages`, { content: 'start something long' });
  assert.equal(running.status, 200);
  // Read until the turn has actually started streaming: that is the point from
  // which it owns the session server-side, so a 409 after it is meaningful and
  // a 409 before it would just be a race.
  const reader = running.body!.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  const deadline = Date.now() + 20_000;
  while (!seen.includes('"type":"message.delta"') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  assert.ok(seen.includes('message.delta'), 'the hang turn never started streaming');

  const res = await post(`/api/sessions/${sessionId}/compact`);
  assert.equal(res.status, 409);
  assert.match(String((await res.json()).error), /turn is running/);

  // Let the turn finish on its own rather than stopping it: stopping aborts the
  // provider request inside msw, and the mock's socket teardown asserts on that.
  // Draining to the end also guarantees the turn is over before the next test.
  while (!(await reader.read()).done) {
    /* until the hung stream closes */
  }
  hang = false;
});

test('a second compaction of the same session works again once there is more history', { timeout: 60_000 }, async () => {
  await sendTurn(sessionId, 'more work: ' + 'filler '.repeat(200));
  const res = await post(`/api/sessions/${sessionId}/compact`);
  assert.equal(res.status, 200);
  const evs = await events(res);
  assert.ok(evs.some((e) => e.type === 'compaction'), 'second compaction did not run');
});
