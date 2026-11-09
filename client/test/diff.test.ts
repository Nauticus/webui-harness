import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff, pathFromDiff, splitRows } from '../src/lib/diff';

const imageLines = (lines: ReturnType<typeof parseUnifiedDiff>['lines'], side: 'left' | 'right') =>
  lines.filter((l) => l.kind === 'ctx' || l.kind === (side === 'left' ? 'del' : 'add')).map((l) => l.text);

/** Read one column of the split view top to bottom. */
const column = (rows: ReturnType<typeof splitRows>, side: 'left' | 'right') =>
  rows.flatMap((r) => (r.kind === 'cells' && r[side].line ? [r[side].line!.text] : []));

const cells = (rows: ReturnType<typeof splitRows>) => rows.filter((r) => r.kind === 'cells');

test('the split view loses nothing: each column is one side of the file', () => {
  const diffs = [
    // one change, one line each side
    ['@@ -1,3 +1,3 @@', ' a', '-b', '+c', ' d'].join('\n'),
    // additions only, deletions only
    ['@@ -0,0 +1,2 @@', '+a', '+b'].join('\n'),
    ['@@ -1,2 +0,0 @@', '-a', '-b'].join('\n'),
    // unequal sides
    ['@@ -4,2 +4,5 @@', '-gone', '+one', '+two', '+three'].join('\n'),
    ['@@ -4,4 +4,1 @@', '-one', '-two', '-three', '+kept'].join('\n'),
    // interleaved, which a plain run-split would pair wrong
    ['@@ -1,4 +1,4 @@', '-a', '+b', '-c', '+d'].join('\n'),
    // several hunks, and a long run of context between them
    [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,4 +1,5 @@',
      ' one',
      '-two',
      '+two',
      '+two-and-a-half',
      ' three',
      ' four',
      '@@ -40,2 +41,2 @@',
      '-x',
      '+y',
      ' z',
    ].join('\n'),
    // a context line that is genuinely empty, and a no-newline marker
    ['@@ -1,3 +1,3 @@', 'a', '', 'c', '\\ No newline at end of file'].join('\n'),
    // two files in one output
    [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+A',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-b',
      '+B',
    ].join('\n'),
  ];

  for (const [i, diff] of diffs.entries()) {
    const parsed = parseUnifiedDiff(diff);
    const rows = splitRows(parsed.lines);
    assert.deepEqual(column(rows, 'left'), imageLines(parsed.lines, 'left'), `diff ${i}: left column is the file before`);
    assert.deepEqual(column(rows, 'right'), imageLines(parsed.lines, 'right'), `diff ${i}: right column is the file after`);
  }
});

test('a changed block pairs by position and pads the short side', () => {
  const { lines } = parseUnifiedDiff(['@@ -4,2 +4,5 @@', '-gone', '+one', '+two', '+three'].join('\n'));
  const rows = cells(splitRows(lines));
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => [r.left.kind, r.right.kind]),
    [
      ['del', 'add'],
      ['blank', 'add'],
      ['blank', 'add'],
    ]
  );
});

test('a context line stands on both sides, a hunk header spans them', () => {
  const { lines } = parseUnifiedDiff(['@@ -1,2 +1,2 @@', ' same', '-x', '+y'].join('\n'));
  const rows = splitRows(lines);
  assert.equal(rows[0]!.kind, 'hunk');
  const ctx = rows[1]!;
  assert.ok(ctx.kind === 'cells');
  assert.equal(ctx.left.line, ctx.right.line, 'the same row, not a copy that could drift');
});

test('line numbers come from the hunk header, and each hunk restarts them', () => {
  const { lines } = parseUnifiedDiff(
    ['@@ -10,3 +20,3 @@', ' a', '-b', '+c', ' d', '@@ -40,1 +50,1 @@', '-e', '+f'].join('\n')
  );
  assert.deepEqual(
    lines.map((l) => [l.kind, l.pre, l.post]),
    [
      ['hunk', undefined, undefined],
      ['ctx', 10, 20],
      ['del', 11, undefined],
      ['add', undefined, 21],
      ['ctx', 12, 22],
      ['hunk', undefined, undefined],
      ['del', 40, undefined],
      ['add', undefined, 50],
    ]
  );
});

test('a new file has no before side', () => {
  const { lines, adds, dels } = parseUnifiedDiff(['@@ -0,0 +1,2 @@', '+a', '+b'].join('\n'));
  assert.deepEqual([adds, dels], [2, 0]);
  assert.deepEqual(
    lines.map((l) => [l.pre, l.post]),
    [
      [undefined, undefined],
      [undefined, 1],
      [undefined, 2],
    ]
  );
});

test("a second file's headers are rows of nothing", () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+A',
    'diff --git a/b.ts b/b.ts',
    'index 3..4 100644',
    '--- a/b.ts',
    '+++ b/b.ts',
    '@@ -1,1 +1,1 @@',
    '-b',
    '+B',
  ].join('\n');
  const { lines, adds, dels } = parseUnifiedDiff(diff);
  assert.deepEqual([adds, dels], [2, 2], 'only the real changes counted');
  assert.deepEqual(
    lines.filter((l) => l.kind !== 'hunk').map((l) => l.text),
    ['a', 'A', 'b', 'B']
  );
});

test('the file comes from the diff header', () => {
  assert.equal(pathFromDiff('diff --git a/src/old.ts b/src/new.ts\n@@ -1 +1 @@\n x'), 'src/new.ts');
  assert.equal(pathFromDiff('--- a/x.ts\n+++ b/only/plus.ts\n@@ -1 +1 @@\n x'), 'only/plus.ts');
  assert.equal(pathFromDiff('@@ -1 +1 @@\n x'), '');
});
