import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright';

/**
 * End-to-end test for the `@` file picker: a real browser drives the real client
 * against the real server, whose workspace is a temp directory with known files.
 *
 * No provider is involved — nothing is sent — because the feature is entirely
 * about turning a keystroke into a path in the composer:
 *   - typing `@` opens the picker and shows the project's working directory
 *   - the filter searches the tree and the pick lands in the prompt
 *   - directories are browsed, not picked, and `..` walks back out
 *   - the API only ever serves paths inside the project directory
 */

const APP_PORT = 3486;
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

let app: { close: () => Promise<void> } | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
let dataDir = '';
let workspace = '';
let projectId = '';

/** Build the client, serialized with other e2e files (they run in parallel). */
async function buildClient(): Promise<void> {
  const lock = path.join(os.tmpdir(), 'webui-h-client-build-lock');
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

const composer = (p: Page) => p.locator('textarea[placeholder="Ask the agent to do something…"]');
const prompt = (p: Page) => composer(p).inputValue();

/** Put the caret at the end of `text` and type an `@`, so the picker opens the
 *  way it does for a person: on a keystroke, not on a value assignment. */
async function openPromptAt(p: Page, text: string): Promise<void> {
  await composer(p).fill(text);
  await composer(p).click();
  await composer(p).pressSequentially('@');
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-h-fp-data-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-h-fp-ws-'));
  for (const f of ['src/app.ts', 'src/lib/clip.ts', 'README.md', 'docs/spec.md', 'node_modules/noise/index.js']) {
    fs.mkdirSync(path.join(workspace, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(workspace, f), 'x');
  }
  process.env.PORT = String(APP_PORT);
  process.env.WEBUI_H_DATA_DIR = dataDir;
  process.env.AGENT_WORKSPACE_DIR = workspace;
  process.env.OPENAI_API_KEY = '';
  await buildClient();
  app = (await import('../src/index')).app;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${APP_BASE}/api/health`)).ok) break;
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
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('@ file picker', { timeout: 180_000 }, async (t) => {
  const proj = await fetch(`${APP_BASE}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'picker', cwd: workspace }),
  });
  assert.equal(proj.status, 201);
  projectId = (await proj.json()).id as string;
  const p = page!;

  await t.test('the API lists the project directory, noise excluded', async () => {
    const res = await fetch(`${APP_BASE}/api/files?projectId=${projectId}`).then((r) => r.json() as Promise<{
      entries: { path: string; type: string }[];
    }>);
    assert.deepEqual(res.entries, [
      { path: 'docs', type: 'dir' },
      { path: 'src', type: 'dir' },
      { path: 'README.md', type: 'file' },
    ]);
  });

  await t.test('the API searches by path and refuses to leave the project', async () => {
    const hit = await fetch(`${APP_BASE}/api/files?projectId=${projectId}&q=clip`).then((r) =>
      r.json() as Promise<{ entries: { path: string }[] }>
    );
    assert.deepEqual(hit.entries.map((e) => e.path), ['src/lib/clip.ts']);

    for (const bad of ['../..', '/etc', 'a/../../..']) {
      const res = await fetch(`${APP_BASE}/api/files?projectId=${projectId}&dir=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 400, `${bad} must not be listable`);
    }
    assert.equal((await fetch(`${APP_BASE}/api/files?projectId=nope`)).status, 404);
  });

  await t.test('typing @ opens the picker on the project root', async () => {
    await p.goto(`${APP_BASE}/${projectId}`);
    await composer(p).waitFor({ timeout: 30_000 });
    await composer(p).click();
    await composer(p).pressSequentially('@');

    const filter = p.getByRole('textbox', { name: 'Filter files' });
    await filter.waitFor({ timeout: 30_000 });
    await p.getByText('README.md').waitFor({ timeout: 30_000 });
    assert.ok((await p.getByRole('listbox').textContent())?.includes('src'), 'directories are listed');
    assert.ok(!(await p.getByRole('listbox').textContent())?.includes('node_modules'), 'noise stays out');
  });

  await t.test('the filter searches the tree and the pick lands in the prompt', async () => {
    const filter = p.getByRole('textbox', { name: 'Filter files' });
    await filter.pressSequentially('clip', { delay: 30 });
    await p.getByText('clip.ts').waitFor({ timeout: 30_000 });
    await p.keyboard.press('Enter');

    await filter.waitFor({ state: 'detached', timeout: 30_000 });
    assert.equal(await prompt(p), '@src/lib/clip.ts ');
    // Focus is back in the prompt with the caret after the reference.
    assert.equal(
      await p.evaluate(() => document.activeElement instanceof HTMLTextAreaElement),
      true,
      'the composer takes focus back'
    );
  });

  await t.test('typing continues around a picked reference', async () => {
    await p.locator('textarea').pressSequentially('what does it do?', { delay: 10 });
    assert.equal(await prompt(p), '@src/lib/clip.ts what does it do?');
  });

  await t.test('directories are browsed, and Tab takes one', async () => {
    await openPromptAt(p, 'look at ');
    const filter = p.getByRole('textbox', { name: 'Filter files' });
    await filter.waitFor({ timeout: 30_000 });

    // Enter goes into a directory instead of picking it.
    await p.getByText('src/').click();
    await p.getByText('app.ts').waitFor({ timeout: 30_000 });

    // Backspace on an empty filter walks back out.
    await p.keyboard.press('Backspace');
    await p.getByText('README.md').waitFor({ timeout: 30_000 });

    // Tab takes the highlighted entry — here a directory, with its slash. The
    // "searching" line is what says the tree search landed; the rows before it
    // are still the root listing, which happens to show src/ too.
    await p.mouse.move(4, 4); // off the rows: a row under the cursor is highlighted
    await filter.pressSequentially('src', { delay: 30 });
    await p.getByText('searching').waitFor({ timeout: 30_000 });
    await p.getByRole('option').first().getByText('src/').waitFor({ timeout: 30_000 });
    await p.keyboard.press('Tab');
    await filter.waitFor({ state: 'detached', timeout: 30_000 });
    assert.equal(await prompt(p), 'look at @src/ ');
  });

  await t.test('escape closes it without touching the prompt', async () => {
    await openPromptAt(p, 'nothing ');
    const filter = p.getByRole('textbox', { name: 'Filter files' });
    await filter.waitFor({ timeout: 30_000 });
    await p.keyboard.press('Escape');
    await filter.waitFor({ state: 'detached', timeout: 30_000 });
    assert.equal(await prompt(p), 'nothing @');
  });

  await t.test('the @ file button opens the same picker', async () => {
    await p.locator('textarea').fill('');
    await p.getByRole('button', { name: 'Pick a file for the prompt' }).click();
    const filter = p.getByRole('textbox', { name: 'Filter files' });
    await filter.waitFor({ timeout: 30_000 });
    await p.getByText('README.md').waitFor({ timeout: 30_000 });
    await p.keyboard.press('Escape');
    await filter.waitFor({ state: 'detached', timeout: 30_000 });
    assert.equal(await prompt(p), '');
  });

  await t.test('a picked reference is highlighted in the sent message', async () => {
    // The bubble renders the same text the model gets, with the path set apart.
    const sent = '@README.md summarize this';
    await p.locator('textarea').fill(sent);
    await p.getByRole('button', { name: 'Send' }).click().catch(() => {
      /* no provider configured: the turn fails, the bubble still appears */
    });
    const chip = p.locator('main').getByText('@README.md', { exact: true });
    await chip.waitFor({ timeout: 30_000 });
    assert.equal(await chip.evaluate((el) => el.textContent), '@README.md');
  });
});
