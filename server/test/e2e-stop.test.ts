import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * End-to-end stop test with a mock OpenAI-compatible provider:
 * - stopping mid tool-batch kills the running command, stubs the remaining
 *   tool calls (history stays valid), and ends the agent loop
 * - stopping mid text-stream persists the partial assistant text
 * - the agent never makes another LLM call after a stop
 */

const MOCK_PORT = 3481;
const APP_PORT = 3482;
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;

// ---------- mock provider ----------

type MockMode = 'sleep-tools' | 'stall-text';
let mockMode: MockMode = 'sleep-tools';
let llmCalls = 0;

function sseWrite(res: http.ServerResponse, obj: unknown) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function chunk(res: http.ServerResponse, delta: unknown) {
  sseWrite(res, { id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] });
}

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
      llmCalls++;
      const parsed = JSON.parse(body);
      res.setHeader('Content-Type', 'text/event-stream');
      if (mockMode === 'sleep-tools') {
        // One round with two tool calls: a long-running bash first, then a
        // read_file that must get stubbed if the turn is stopped mid-batch.
        chunk(res, { role: 'assistant', content: '' });
        chunk(res, {
          tool_calls: [
            {
              index: 0,
              id: 'call_s1',
              type: 'function',
              function: { name: 'bash', arguments: '{"command":"sleep 3"}' },
            },
            {
              index: 1,
              id: 'call_s2',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"notes.txt"}' },
            },
          ],
        });
        chunk(res, {});
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        // Stream a short prefix, then stall forever (never [DONE], no end).
        chunk(res, { role: 'assistant', content: '' });
        chunk(res, { content: 'Hello ' });
        // Intentionally not ended: simulates a model still "thinking".
        req.socket.setTimeout(0);
      }
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

/**
 * Start the turn's SSE stream; the pump keeps reading (and buffering events)
 * in the background so the stream stays open. Resolves once `until` matches
 * an event. `abort()` closes the connection — exactly what the client's stop
 * button does.
 */
async function startTurn(
  sessionId: string,
  content: string,
  until: (ev: SseEvent) => boolean
): Promise<{ events: SseEvent[]; abort: () => void }> {
  const controller = new AbortController();
  const res = await fetch(`${APP_BASE}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  assert.ok(res.body);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buf = '';
  let pending: (() => void) | null = null;
  let untilFn = until;
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
        if (untilFn(ev)) {
          untilFn = () => false;
          pending!();
        }
      }
    }
  })().catch(() => {
    /* aborted or stream ended */
  });
  await matched;
  return { events, abort: () => controller.abort() };
}

async function sessionRows(sessionId: string) {
  const s = await fetch(`${APP_BASE}/api/sessions/${sessionId}`).then((r) =>
    r.json() as {
      messages: { role: string; content: string; meta: string | null }[];
    }
  );
  return s.messages.map((m) => ({
    role: m.role,
    content: m.content,
    meta: m.meta ? (JSON.parse(m.meta) as Record<string, unknown>) : null,
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weblisan-e2e-stop-data-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'weblisan-e2e-stop-ws-'));
  app = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.resolve(new URL('..', import.meta.url).pathname),
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      WEBLISAN_DATA_DIR: dataDir,
      COMPACT_CONTEXT_WINDOW: '100000', // compaction disabled; out of scope here
    },
    stdio: ['ignore', 'pipe', 'pipe'],
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
  app?.kill();
  await sleep(200);
  mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('e2e: stop kills the running command, stubs remaining calls, ends the loop', { timeout: 60_000 }, async () => {
  const prov = await post('/api/providers', { name: 'mock', baseUrl: MOCK_BASE, apiKey: 'k', isDefault: true });
  assert.equal(prov.status, 201);
  const proj = await post('/api/projects', { name: 'e2e-stop', cwd: workspace });
  assert.equal(proj.status, 201);
  const sess = await post('/api/sessions', { projectId: (await proj.json()).id });
  assert.equal(sess.status, 201);
  const sessionId = (await sess.json()).id as string;

  mockMode = 'sleep-tools';
  llmCalls = 0;

  // The first tool round offers bash(sleep 3) + read_file. Stop 400ms in,
  // while the bash command is still running.
  const { events, abort } = await startTurn(sessionId, 'run the sleeper', (ev) => ev.type === 'tool.start');
  const starts = events.filter((e) => e.type === 'tool.start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0]!.name, 'bash');
  await sleep(400); // sleep 3 is still going
  abort(); // = client stop button
  await sleep(700); // give the server time to clean up and persist

  // The running bash was killed, and the pending read_file was stubbed so
  // every tool_call in history has a matching tool result.
  const rows = await sessionRows(sessionId);
  assert.deepEqual(rows.map((r) => r.role), ['user', 'assistant', 'tool', 'tool']);
  const toolRows = rows.filter((r) => r.role === 'tool');
  assert.match(String(toolRows[0]!.content), /\[stopped by user\]/);
  assert.match(String(toolRows[1]!.content), /stopped by user before this ran/);

  // History validity: every tool_call id from the assistant round has a
  // tool result row.
  const assistant = rows.find((r) => r.role === 'assistant')!;
  const calls = (assistant.meta as { tool_calls?: { id: string }[] } | null)?.tool_calls ?? [];
  assert.equal(calls.length, 2);
  const resultIds = toolRows.map((t) => (t.meta as { tool_call_id?: string } | null)?.tool_call_id);
  for (const c of calls) {
    assert.ok(resultIds.includes(c.id), `tool result for ${c.id} is missing`);
  }

  // No error surfaced over the live stream, and no further LLM call happens.
  assert.ok(!events.some((e) => e.type === 'error'), 'no error event expected');
  assert.equal(llmCalls, 1, 'exactly one LLM call before the stop');
  await sleep(1500);
  assert.equal(llmCalls, 1, 'the agent must not call the LLM again after a stop');
});

test('e2e: stop mid text-stream persists the partial assistant text', { timeout: 60_000 }, async () => {
  const proj = await post('/api/projects', { name: 'e2e-stop2', cwd: workspace });
  assert.equal(proj.status, 201);
  const sess = await post('/api/sessions', { projectId: (await proj.json()).id });
  assert.equal(sess.status, 201);
  const sessionId = (await sess.json()).id as string;

  mockMode = 'stall-text';

  const { events, abort } = await startTurn(
    sessionId,
    'say hello slowly',
    (ev) => ev.type === 'message.delta'
  );
  const deltas = events.filter((e) => e.type === 'message.delta');
  assert.equal(deltas.length, 1);
  assert.equal(String(deltas[0]!.text), 'Hello ');
  await sleep(300); // the model is still "thinking" (stalled stream)
  abort(); // = client stop button
  await sleep(700);

  const rows = await sessionRows(sessionId);
  assert.deepEqual(rows.map((r) => r.role), ['user', 'assistant']);
  assert.equal(rows[1]!.content, 'Hello ');
  assert.equal((rows[1]!.meta as { stopped?: boolean } | null)?.stopped, true);

  assert.ok(!events.some((e) => e.type === 'error'), 'no error event expected');
});
