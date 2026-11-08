import test from 'node:test';
import assert from 'node:assert/strict';
import { asJson, looksLikeDiff } from '../src/lib/toolOutput';

test('a unified diff is recognised, a mention of one is not', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1234567..89abcde 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,3 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
  ].join('\n');
  assert.equal(looksLikeDiff(diff), true);
  assert.equal(looksLikeDiff('git apply failed on @@ -1,2 +1,3 @@ in the patch'), false);
  assert.equal(looksLikeDiff('--- a/README ---\nsome prose with dashes'), false);
  assert.equal(looksLikeDiff('src/a.ts | 2 +-\n 1 file changed'), false);
});

test('a JSON document is recognised, prose containing JSON is not', () => {
  assert.deepEqual(asJson('{"a": 1}'), { a: 1 });
  assert.deepEqual(asJson('[1, 2, 3]'), [1, 2, 3]);
  assert.deepEqual(asJson('\n  {"a": 1}\n'), { a: 1 });
  assert.equal(asJson('the command printed {"a": 1} and exited'), undefined);
  assert.equal(asJson('{"a": 1} trailing'), undefined);
  assert.equal(asJson(''), undefined);
  assert.equal(asJson('"just a string"'), undefined);
  assert.equal(asJson('null'), undefined);
});

test('huge output is not parsed', () => {
  assert.equal(asJson('[' + '1,'.repeat(200_000) + ']'), undefined);
});
