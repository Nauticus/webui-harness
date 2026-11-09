import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-h-toolok-'));
const { runTool } = await import('../src/tools');

// The UI must be able to tell success from failure without reading the prose
// of the output — so every failure path sets ok: false, and a command that
// fails is no longer indistinguishable from one that succeeds silently.

test('runTool: a failing exit code is a failure, and says so to the model', async () => {
  const res = await runTool('bash', { command: 'false' }, ws);
  assert.equal(res.ok, false);
  assert.match(res.output, /\[exit code 1\]/);
});

test('runTool: a silent success is not a failure', async () => {
  const res = await runTool('bash', { command: 'true' }, ws);
  assert.notEqual(res.ok, false);
  assert.equal(res.output, '(no output)');
});

test('runTool: exit code 0 with output stays a success', async () => {
  const res = await runTool('bash', { command: 'echo hello' }, ws);
  assert.notEqual(res.ok, false);
  assert.match(res.output, /hello/);
});

test('runTool: a non-zero exit keeps the command output alongside the code', async () => {
  const res = await runTool('bash', { command: 'echo out; echo err >&2; exit 3' }, ws);
  assert.equal(res.ok, false);
  assert.match(res.output, /out/);
  assert.match(res.output, /err/);
  assert.match(res.output, /\[exit code 3\]/);
});

test('runTool: every failure shape carries ok: false', async () => {
  const cases: [string, Record<string, unknown>][] = [
    ['nope', {}],
    ['read_file', { path: 'missing-file.txt' }],
    ['read_file', { path: '/etc/hostname' }],
    ['edit_file', { path: 'x.txt', edits: [] }],
    ['bash', { command: '   ' }],
  ];
  for (const [name, args] of cases) {
    const res = await runTool(name, args, ws);
    assert.equal(res.ok, false, `${name} should be a failure: ${res.output}`);
    assert.match(res.output, /^error: /, `${name} keeps the error: prefix`);
  }
});

test('runTool: write_file and edit_file successes carry no failure flag', async () => {
  const w = await runTool('write_file', { path: 'a.txt', content: 'one\n' }, ws);
  assert.notEqual(w.ok, false);
  const e = await runTool(
    'edit_file',
    { path: 'a.txt', edits: [{ oldText: 'one', newText: 'two' }] },
    ws
  );
  assert.notEqual(e.ok, false);
  assert.ok(e.diff, 'edit still returns a diff');
});

test('runTool: an edit that changes nothing is not an error', async () => {
  await runTool('write_file', { path: 'same.txt', content: 'same\n' }, ws);
  const res = await runTool(
    'edit_file',
    { path: 'same.txt', edits: [{ oldText: 'same', newText: 'same' }] },
    ws
  );
  assert.notEqual(res.ok, false);
  assert.match(res.output, /no change/);
});

// The command line is coloured as the shell that ran it, so the result has to
// say which that was — including when it failed, which is exactly when the
// reader wants to know whether the shell or the command was wrong.

test('runTool: bash reports the shell it used, on success and on failure', async () => {
  const ok = await runTool('bash', { command: 'echo hi' }, ws);
  assert.equal(ok.shell, process.platform === 'win32' ? 'powershell' : 'bash');
  const bad = await runTool('bash', { command: 'false' }, ws);
  assert.equal(bad.shell, ok.shell, 'a failure must not lose the shell');
});

test('runTool: a command that never ran reports no shell', async () => {
  const res = await runTool('bash', { command: '   ' }, ws);
  assert.equal(res.ok, false);
  assert.equal('shell' in res, false, 'nothing executed, so nothing to name');
});

test('runTool: only bash reports a shell', async () => {
  const res = await runTool('list_dir', { path: '.' }, ws);
  assert.equal('shell' in res, false);
});
