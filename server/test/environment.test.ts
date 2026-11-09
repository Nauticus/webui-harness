import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shellFor, SHELL, runTool, type ShellProbe } from '../src/tools';
import { detectEnvironment, environmentBlock, ENVIRONMENT } from '../src/environment';

const probe = (files: string[], executables = files, whichMap: Record<string, string> = {}): ShellProbe => ({
  isFile: (p) => files.includes(p),
  isExecutable: (p) => executables.includes(p),
  which: (name) => whichMap[name],
});

test('a host with bash runs bash and says bash', () => {
  const s = shellFor('linux', probe(['/bin/bash']));
  assert.equal(s.name, 'bash');
  assert.equal(s.file, '/bin/bash');
  assert.equal(s.dialect, 'bash');
});

test('a host with no bash falls back to sh and stops claiming bash', () => {
  const s = shellFor('linux', probe(['/bin/sh'], ['/bin/sh']));
  assert.equal(s.file, '/bin/sh');
  assert.equal(s.dialect, 'posix');
  assert.equal(s.blurb, 'sh -c');
});

test('a bash that is on PATH but not at /bin/bash still counts as bash', () => {
  const s = shellFor('linux', probe(['/usr/local/bin/bash'], ['/usr/local/bin/bash'], {
    bash: '/usr/local/bin/bash',
  }));
  assert.equal(s.dialect, 'bash');
  assert.equal(s.file, '/usr/local/bin/bash');
});

test('a windows host runs powershell, not bash', () => {
  const s = shellFor('win32', probe([]));
  assert.equal(s.name, 'powershell');
  assert.equal(s.file, 'powershell.exe');
  assert.deepEqual(s.argv, ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(s.dialect, 'powershell');
});

test('PowerShell 7 wins over the 5.1 in System32, because they are different languages', () => {
  const s = shellFor('win32', probe(['C:\\ps7\\pwsh.exe'], ['C:\\ps7\\pwsh.exe'], {
    'pwsh.exe': 'C:\\ps7\\pwsh.exe',
    'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  }));
  assert.equal(s.file, 'C:\\ps7\\pwsh.exe');
  assert.equal(s.blurb, 'pwsh -Command');
});

test('pwsh is found in ProgramFiles even when it is not on PATH', () => {
  const s = shellFor('win32', probe(['C:\\Program Files\\PowerShell\\7\\pwsh.exe']), {
    ProgramFiles: 'C:\\Program Files',
  });
  assert.equal(s.file, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
});

test('no pwsh anywhere falls back to Windows PowerShell', () => {
  const s = shellFor(
    'win32',
    probe(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']),
    { SystemRoot: 'C:\\Windows' }
  );
  assert.equal(s.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(s.blurb, 'powershell -Command');
});

test('a windows AGENT_SHELL_PATH has to be a real .exe', () => {
  assert.throws(
    () => shellFor('win32', probe([]), { AGENT_SHELL_PATH: 'pwsh.exe' }),
    /absolute path/
  );
  assert.throws(
    () => shellFor('win32', probe(['C:\\tools\\pwsh.txt']), { AGENT_SHELL_PATH: 'C:\\tools\\pwsh.txt' }),
    /not an executable file/
  );
  const s = shellFor('win32', probe(['C:\\tools\\pwsh.exe']), { AGENT_SHELL_PATH: 'C:\\tools\\pwsh.exe' });
  assert.equal(s.file, 'C:\\tools\\pwsh.exe');
  assert.equal(s.blurb, 'pwsh -Command');
});

test('AGENT_SHELL_PATH is honoured, and a bad one fails at startup instead of silently', () => {
  const s = shellFor('linux', probe(['/opt/busybox/sh'], ['/opt/busybox/sh']), {
    AGENT_SHELL_PATH: '/opt/busybox/sh',
  });
  assert.equal(s.file, '/opt/busybox/sh');
  assert.equal(s.dialect, 'posix');

  assert.throws(
    () => shellFor('linux', probe([]), { AGENT_SHELL_PATH: 'nope/bash' }),
    /absolute path/
  );
  assert.throws(
    () => shellFor('linux', probe([]), { AGENT_SHELL_PATH: '/nowhere/bash' }),
    /not an executable file/
  );
});

test('the block names the executable that will actually run', () => {
  const info = detectEnvironment({}, 'linux', shellFor('linux', probe(['/bin/bash'])));
  const block = environmentBlock(info);
  assert.ok(block.includes('/bin/bash -c'), block);
  assert.ok(/Bash syntax/.test(block), block);
});

test('the block warns against bash-isms when the shell is sh', () => {
  const info = detectEnvironment({}, 'linux', shellFor('linux', probe(['/bin/sh'], ['/bin/sh'])));
  const block = environmentBlock(info);
  assert.ok(block.includes('/bin/sh -c'), block);
  assert.ok(block.includes('not Bash'), block);
  assert.ok(block.includes('[['), block);
});

test('the block says startup files do not run, because that is the usual wrong guess', () => {
  const block = environmentBlock();
  assert.match(block, /not sourced/);
});

test('powershell 7 gets no 5.1 warning, so the model may use && and ||', () => {
  const shell = shellFor('win32', probe(['C:\\ps7\\pwsh.exe'], ['C:\\ps7\\pwsh.exe'], {
    'pwsh.exe': 'C:\\ps7\\pwsh.exe',
  }));
  const rendered = environmentBlock(detectEnvironment({}, 'win32', shell));
  assert.ok(rendered.includes('C:\\ps7\\pwsh.exe'), rendered);
  assert.ok(!rendered.includes('5.1'), rendered);
  assert.match(rendered, /PowerShell syntax/);
});

test('windows powershell 5.1 is named, because && is a syntax error there', () => {
  const rendered = environmentBlock(detectEnvironment({}, 'win32', shellFor('win32', probe([]))));
  assert.match(rendered, /Windows PowerShell 5\.1/);
  assert.match(rendered, /&&/);
});

test('a container is flagged so the model does not reach for systemctl', () => {
  const info = detectEnvironment({ container: 'docker' }, 'linux', SHELL);
  assert.ok(info.container);
  assert.match(environmentBlock(info), /container/);
});

test('the block is deterministic, so the token estimate matches the prompt', () => {
  assert.equal(environmentBlock(), environmentBlock());
  assert.equal(ENVIRONMENT.platform, process.platform);
});

test('the block carries no host identity or environment values', () => {
  const block = environmentBlock();
  assert.ok(!block.includes(os.hostname()), 'hostname would be a leak into a provider prompt');
  assert.ok(!block.includes(os.userInfo().username), 'username likewise');
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 12 || key.startsWith('WEBUI_H_')) continue;
    assert.ok(!block.includes(value), `environment value leaked: ${key}`);
  }
});

test('a command can check the sandbox it is in rather than infer it from prose', {
  skip: process.platform === 'win32' ? 'posix syntax in the probe' : false,
}, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-h-env-'));
  const res = await runTool(
    'bash',
    { command: 'printf "%s|%s|%s\\n" "$WEBUI_H_AGENT" "$(pwd)" "$WEBUI_H_WORKSPACE"' },
    ws
  );
  const [marker, cwd, declared] = res.output.trim().split('|');
  assert.equal(marker, '1', 'a command should be able to tell it runs inside this agent');
  assert.equal(path.basename(cwd), path.basename(ws), res.output);
  assert.equal(declared, ws, 'the sandbox path is announced to child processes');
});
