import test from 'node:test';
import assert from 'node:assert/strict';
import { SHELL, TOOLS, shellFor, type ShellProbe } from '../src/tools';

const bashTool = TOOLS.find((t) => t.function.name === 'bash')!;

/** Nothing installed, so the windows branch is decided by its own rules, not the test host. */
const none: ShellProbe = { isFile: () => false, isExecutable: () => false, which: () => undefined };

test('a windows host runs powershell, not bash', () => {
  const s = shellFor('win32', none);
  assert.equal(s.name, 'powershell');
  assert.equal(s.file, 'powershell.exe');
  assert.deepEqual(s.argv, ['-NoProfile', '-NonInteractive', '-Command']);
});

test('every other host runs bash', () => {
  for (const p of ['linux', 'darwin', 'freebsd', 'sunos'] as NodeJS.Platform[]) {
    const s = shellFor(p);
    assert.equal(s.name, 'bash', p);
    assert.deepEqual(s.argv, ['-c'], p);
  }
});

test('the profile never runs: a prompt would hang the call, not fail it', () => {
  const s = shellFor('win32', none);
  assert.ok(s.argv.includes('-NoProfile'), 'a profile prints into the output');
  assert.ok(s.argv.includes('-NonInteractive'), 'an interactive prompt would stall until timeout');
});

test('the model is told the shell that will actually run', () => {
  // The description is the only place the model learns what syntax to write, so
  // it must name the same shell the spawn will use on this machine.
  assert.ok(bashTool.function.description!.includes(SHELL.blurb), bashTool.function.description);
  assert.ok(bashTool.function.description!.startsWith('Run a shell command'));
});

test('the shell resolved for this machine matches its platform', () => {
  assert.equal(SHELL.name, process.platform === 'win32' ? 'powershell' : 'bash');
});
