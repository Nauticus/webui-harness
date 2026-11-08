import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { chromium, type Browser, type Page } from 'playwright';

/**
 * Full-stack e2e compaction test: a real browser (Playwright) drives the real
 * React client, served by the real server running in-process, whose provider
 * calls are mocked with msw (OpenAI-compatible /v1 endpoint).
 *
 * Verifies the compaction behavior end to end through the UI:
 * - a normal turn renders user bubble, tool card, and the assistant text
 * - a large message triggers pre-turn compaction and the compaction card
 *   appears in the chat (expandable, with the produced summary)
 * - the context-usage bar is present
 */

const APP_PORT = 3482;
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;
const MOCK_BASE = 'http://mock-provider.fullstack/v1';
const MOCK_SUMMARY =
  '## Goal\nDo the test thing\n\n## Progress\n### Done\n- [x] echoed hello from the shell';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

// ---------- msw-mocked provider ----------

const mockRequests: Record<string, unknown>[] = [];

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
  out.push({ id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {} }] });
  return out;
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
                function: { name: 'bash', arguments: '{"command":"echo mock-hello"}' },
              },
            ],
          },
        },
      ],
    },
    { id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {} }] },
  ];
}

const providerServer = setupServer(
  http.get(`${MOCK_BASE}/models`, () =>
    HttpResponse.json({ data: [{ id: 'mock-model-1' }, { id: 'mock-model-2' }] })
  ),
  http.post(`${MOCK_BASE}/chat/completions`, async ({ request }) => {
    const parsed = (await request.json()) as Record<string, unknown>;
    mockRequests.push(parsed);
    const messages = (parsed.messages ?? []) as { role: string; content?: unknown }[];
    const lastRole = messages[messages.length - 1]?.role;
    const hasToolResult = messages.some((m) => m.role === 'tool');

    if (isSummarizerReq(parsed)) return sseResponse(sseChunks(MOCK_SUMMARY));
    return sseResponse(!hasToolResult && lastRole === 'user' ? streamToolCall() : sseChunks('done: mock replied'));
  })
);

// ---------- server under test (in-process) + browser ----------

let app: { close: () => Promise<void> } | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
let dataDir = '';
let workspace = '';

/** Build the client, serialized with other e2e files (they run in parallel). */
async function buildClient(): Promise<void> {
  const lock = path.join(os.tmpdir(), 'weblisan-client-build-lock');
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  try {
    execSync('npm run build -w client', { cwd: ROOT, stdio: 'ignore' });
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function post(path: string, body: unknown) {
  return fetch(`${APP_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weblisan-e2e-data-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'weblisan-e2e-ws-'));
  // Set before the import: the server reads these at module load.
  process.env.PORT = String(APP_PORT);
  process.env.WEBLISAN_DATA_DIR = dataDir;
  process.env.AGENT_WORKSPACE_DIR = workspace;
  process.env.COMPACT_CONTEXT_WINDOW = '100000';
  process.env.COMPACT_RESERVE_TOKENS = '2000';
  process.env.COMPACT_KEEP_RECENT_TOKENS = '1000';
  process.env.OPENAI_API_KEY = ''; // no .env import of a real provider
  await buildClient();
  providerServer.listen({ onUnhandledFrame: 'bypass' });
  app = (await import('../src/index')).app;
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
  browser = await chromium.launch();
  page = await browser.newPage();
});

test.after(async () => {
  await page?.close();
  await browser?.close();
  await app?.close();
  providerServer.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('full stack: UI turn and compaction through the browser', { timeout: 180_000 }, async (t) => {
  const p = page!;

  // Setup through the API: provider (per-model window 5000 -> threshold 3000),
  // project, session. The browser then opens that session directly — the URL
  // is the selection.
  const prov = await post('/api/providers', { name: 'mock', baseUrl: MOCK_BASE, apiKey: 'k', isDefault: true });
  assert.equal(prov.status, 201);
  const provId = (await prov.json()).id as string;
  const patch = await fetch(`${APP_BASE}/api/providers/${provId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelContextWindows: { 'mock-model-1': 5000 } }),
  });
  assert.equal(patch.status, 200);
  const proj = await post('/api/projects', { name: 'e2e', cwd: workspace });
  assert.equal(proj.status, 201);
  const projId = (await proj.json()).id as string;
  const sess = await post('/api/sessions', { projectId: projId });
  assert.equal(sess.status, 201);
  const sessionId = (await sess.json()).id as string;

  await p.goto(`${APP_BASE}/${projId}/${sessionId}`);

  // The composer's placeholder only shows once the project is loaded.
  await p.locator('textarea[placeholder="Ask the agent to do something…"]').waitFor({ timeout: 30_000 });

  await t.test('normal turn renders user bubble, tool card, and assistant text', async () => {
    await p.locator('textarea').fill('say hello with the shell');
    await p.getByRole('button', { name: 'Send' }).click();

    // User bubble (scoped to main: the sidebar session title matches too).
    await p.locator('main').getByText('say hello with the shell', { exact: true }).waitFor({ timeout: 30_000 });
    // Tool card with the command target.
    await p.getByText('echo mock-hello').waitFor({ timeout: 30_000 });
    // Final assistant text.
    await p.getByText('done: mock replied').waitFor({ timeout: 30_000 });

    // The context-usage bar is present (title: "context N% used (…)").
    // The chat also has a floating chip titled "context: …" — the space after
    // "context" distinguishes the bar.
    const bar = p.locator('div[title^="context "]');
    await bar.waitFor({ timeout: 30_000 });
    const title = (await bar.getAttribute('title')) ?? '';
    assert.ok(title.includes('/ 5k tokens'), `bar should show the per-model window, got: ${title}`);
  });

  await t.test('large message triggers the compaction card in the chat', async () => {
    mockRequests.length = 0;
    await p.locator('textarea').fill('x'.repeat(16_000)); // ~4000 tokens > 3000 threshold
    await p.getByRole('button', { name: 'Send' }).click();

    // The compaction card appears (done state) — pre-turn and mid-turn
    // compaction can both fire in one turn, so use the last card.
    const card = p.getByText('context compacted').last();
    await card.waitFor({ timeout: 60_000 });
    await p.getByText('done: mock replied').last().waitFor({ timeout: 60_000 });

    // The summarizer was called with the serialized span.
    const summaryReq = mockRequests.find((r) => isSummarizerReq(r));
    assert.ok(summaryReq, 'expected a summarizer call');
    const reqUser = (summaryReq!.messages as { content?: string }[])[1]!;
    assert.ok(String(reqUser.content).includes('[User]:'), 'serialized span should use [User] labels');

    // Expanding the card shows the produced summary (both cards hold the
    // same summary text; the closed one is in the DOM but not rendered).
    await card.click();
    await p.getByText('Do the test thing').last().waitFor({ timeout: 30_000 });

    // History holds the compaction record.
    const s = await fetch(`${APP_BASE}/api/sessions/${sessionId}`).then((r) => r.json() as {
      messages: { role: string }[];
    });
    assert.ok(s.messages.some((m) => m.role === 'compaction'), 'history should include a compaction record');
  });
});
