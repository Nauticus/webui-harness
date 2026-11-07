import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * End-to-end reasoning-effort test with a mock OpenAI-compatible provider:
 * - the session's effort reaches the LLM request body (generic mapping)
 * - auto ('') sends no effort params at all
 * - a mid-flight effort change takes effect on the next message
 * - invalid effort values are rejected at the API boundary
 */

const MOCK_PORT = 3491;
const APP_PORT = 3492;
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;

// ---------- mock provider (records the request body) ----------

let capturedBody: Record<string, unknown> = {};

const mock = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'mock-model-1' }] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      capturedBody = JSON.parse(body);
      res.setHeader('Content-Type', 'text/event-stream');
      const chunk = (delta: unknown) =>
        res.write(
          `data: ${JSON.stringify({ id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`
        );
      chunk({ role: 'assistant', content: '' });
      chunk({ content: 'ok' });
      res.write('data: [DONE]\n\n');
      res.end();
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

/** Send a message and resolve once message.complete arrives. */
async function sendMessage(sessionId: string, content: string): Promise<SseEvent[]> {
  const res = await fetch(`${APP_BASE}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  assert.equal(res.status, 200);
  assert.ok(res.body);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buf = '';
  let pending: (() => void) | null = null;
  const matched = new Promise<void>((resolve) => (pending = resolve));
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const ev = JSON.parse(line.slice(6)) as SseEvent;
        events.push(ev);
        if (ev.type === 'message.complete') pending!();
      }
    }
  })().catch(() => {
    /* stream ended */
  });
  await matched;
  void pump;
  return events;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weblisan-e2e-effort-data-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'weblisan-e2e-effort-ws-'));
  app = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.resolve(new URL('..', import.meta.url).pathname),
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      WEBLISAN_DATA_DIR: dataDir,
      COMPACT_CONTEXT_WINDOW: '100000', // compaction disabled; out of scope here
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // New process group so test.after can kill the whole tree (the npx
    // wrapper, the tsx child, everything) — killing only the wrapper
    // orphans the node app and keeps the stdio pipes open.
    detached: true,
  });
  app.stdout?.on('data', (d: Buffer) => process.env.WEBLISAN_E2E_DEBUG && process.stderr.write(`[app] ${d}`));
  app.stderr?.on('data', (d: Buffer) => process.env.WEBLISAN_E2E_DEBUG && process.stderr.write(`[app!] ${d}`));
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${APP_BASE}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('server did not start');
    await sleep(300);
  }
});

test.after(async () => {
  if (app?.pid) {
    try {
      process.kill(-app.pid, 'SIGKILL'); // whole process group
    } catch {
      app.kill('SIGKILL');
    }
  }
  mock.closeAllConnections?.();
  mock.close();
  await new Promise((r) => setTimeout(r, 100));
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('reasoning effort: session effort reaches the LLM, auto sends nothing, mid-flight change applies', async () => {
  const provRes = await post('/api/providers', { name: 'mock', baseUrl: MOCK_BASE, apiKey: 'k' });
  const prov = (await provRes.json()) as { id: string };
  const projRes = await post('/api/projects', { name: 'e2e', cwd: workspace, providerId: prov.id });
  const proj = (await projRes.json()) as { id: string };

  // Session with an explicit effort.
  const s1 = (await post('/api/sessions', { projectId: proj.id, reasoningEffort: 'high' }).then((r) => r.json())) as {
    id: string;
    reasoning_effort: string;
  };
  assert.equal(s1.reasoning_effort, 'high');

  await sendMessage(s1.id, 'hello');
  assert.equal(capturedBody.reasoning_effort, 'high');

  // Auto session: no effort params at all.
  const s2 = (await post('/api/sessions', { projectId: proj.id }).then((r) => r.json())) as { id: string };
  assert.equal(s2.reasoning_effort, '');
  capturedBody = {};
  await sendMessage(s2.id, 'hello again');
  assert.ok(!('reasoning_effort' in capturedBody));
  assert.ok(!('reasoning' in capturedBody));
  assert.ok(!('thinking_config' in capturedBody));
  assert.ok(!('think' in capturedBody));

  // Mid-flight change: patch to low, next message sends low.
  const patch = await fetch(`${APP_BASE}/api/sessions/${s1.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reasoningEffort: 'low' }),
  }).then((r) => r.json() as { reasoning_effort: string });
  assert.equal(patch.reasoning_effort, 'low');
  capturedBody = {};
  await sendMessage(s1.id, 'again');
  assert.equal(capturedBody.reasoning_effort, 'low');

  // xhigh: accepted at the boundary and passed through as-is.
  await fetch(`${APP_BASE}/api/sessions/${s1.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reasoningEffort: 'xhigh' }),
  });
  capturedBody = {};
  await sendMessage(s1.id, 'once more');
  assert.equal(capturedBody.reasoning_effort, 'xhigh');

  // Invalid values are rejected at the boundary.
  for (const bad of ['bogus', 'LOW', 'xhigh-ish', 'Xhigh']) {
    const res = await fetch(`${APP_BASE}/api/sessions/${s1.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reasoningEffort: bad }),
    });
    assert.equal(res.status, 400);
  }
});
