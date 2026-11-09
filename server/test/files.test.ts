import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IGNORED_DIRS, listWorkspace, rankPaths, resolveInside, scorePath, searchWorkspace } from '../src/files';

/** A throwaway workspace, so the fs-facing tests never touch a real repo. */
async function fixture(files: string[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'files-test-'));
  for (const f of files) {
    await fs.mkdir(path.join(root, path.dirname(f)), { recursive: true });
    await fs.writeFile(path.join(root, f), 'x');
  }
  return root;
}

test('a lookup stays inside the project directory', () => {
  const root = '/srv/project';
  assert.equal(resolveInside(root, 'src/lib/api.ts'), '/srv/project/src/lib/api.ts');
  assert.equal(resolveInside(root, ''), '/srv/project');
  assert.equal(resolveInside(root, './a/../b'), '/srv/project/b');
  for (const bad of ['..', '../outside', '../../etc/passwd', '/etc/passwd', 'a/../../b']) {
    assert.throws(() => resolveInside(root, bad), /escapes/, bad);
  }
});

test('a listing puts directories first and keeps the noise out', async () => {
  const root = await fixture(['src/app.ts', 'README.md', 'node_modules/left-pad/index.js', '.git/config']);
  const res = await listWorkspace(root);
  assert.deepEqual(
    res.entries,
    [
      { path: 'src', type: 'dir' },
      { path: 'README.md', type: 'file' },
    ],
    JSON.stringify(res.entries)
  );
  assert.equal(res.truncated, false);
  await fs.rm(root, { recursive: true, force: true });
});

test('listing a directory that is not there is a 400, not a crash', async () => {
  const root = await fixture(['a.txt']);
  await assert.rejects(() => listWorkspace(root, 'nope'), (e: { statusCode?: number }) => e.statusCode === 400);
  await assert.rejects(() => listWorkspace(root, '../..'), (e: { statusCode?: number }) => e.statusCode === 400);
  await fs.rm(root, { recursive: true, force: true });
});

test('the ignored directories are the ones no one means by @', () => {
  for (const d of ['node_modules', '.git', 'dist', '__pycache__']) assert.ok(IGNORED_DIRS.has(d), d);
});

test('a basename fragment beats the same fragment buried in a path', () => {
  const paths = [
    'client/src/components/Composer.tsx',
    'vendor/copy/composer.ts',
    'src/composer.ts',
    'src/other.ts',
  ].map((p) => ({ path: p }));
  const ranked = rankPaths(paths, 'composer').map((x) => x.path);
  assert.equal(ranked[0], 'src/composer.ts');
  assert.ok(ranked.indexOf('client/src/components/Composer.tsx') > ranked.indexOf('src/composer.ts'));
  assert.ok(!ranked.includes('src/other.ts'), 'a non-match is dropped');
});

test('a path fragment matches across a directory boundary', () => {
  assert.ok(scorePath('client/src/lib/clip.ts', 'src/lib')! > scorePath('a/b/srcxlib.ts', 'src/lib')!);
  assert.equal(scorePath('src/api.ts', 'zz'), null);
});

test('a fuzzy query still finds the file a typo was aiming at', () => {
  assert.notEqual(scorePath('src/components/Composer.tsx', 'cmpsr'), null);
  assert.equal(scorePath('src/api.ts', 'xyz'), null);
});

test('ties go to the shallower path, so short wins over deep', () => {
  const ranked = rankPaths([{ path: 'a/b/c/api.ts' }, { path: 'src/api.ts' }], 'api').map((x) => x.path);
  assert.deepEqual(ranked, ['src/api.ts', 'a/b/c/api.ts']);
});

test('a search finds nested files and offers directories too', async () => {
  const root = await fixture([
    'client/src/components/Composer.tsx',
    'client/src/lib/clip.ts',
    'server/src/files.ts',
    'server/test/files.test.ts',
    'node_modules/deep/Composer.js',
  ]);
  const byName = await searchWorkspace(root, 'composer');
  assert.deepEqual(byName.entries.map((e) => e.path), ['client/src/components/Composer.tsx']);

  const byDir = await searchWorkspace(root, 'src/lib');
  assert.deepEqual(byDir.entries.map((e) => e.path), ['client/src/lib', 'client/src/lib/clip.ts']);

  const nested = await searchWorkspace(root, 'files');
  assert.deepEqual(
    nested.entries.map((e) => e.path),
    ['server/src/files.ts', 'server/test/files.test.ts'],
    'both files, shallowest first'
  );

  const nothing = await searchWorkspace(root, 'zzzz');
  assert.deepEqual(nothing.entries, []);
  assert.equal(nothing.truncated, false);
  await fs.rm(root, { recursive: true, force: true });
});

test('a search caps its results and says so', async () => {
  const root = await fixture(Array.from({ length: 130 }, (_, i) => `d/f${i}.txt`));
  const res = await searchWorkspace(root, 'f');
  assert.equal(res.entries.length, 120);
  assert.equal(res.truncated, true);
  await fs.rm(root, { recursive: true, force: true });
});

test('hidden entries only surface for a query that asks for them', async () => {
  const root = await fixture(['.env.example', 'app.ts']);
  assert.deepEqual((await searchWorkspace(root, 'app')).entries.map((e) => e.path), ['app.ts']);
  assert.deepEqual((await searchWorkspace(root, 'env')).entries.map((e) => e.path), []);
  assert.deepEqual((await searchWorkspace(root, '.env')).entries.map((e) => e.path), ['.env.example']);
  await fs.rm(root, { recursive: true, force: true });
});
