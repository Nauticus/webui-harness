import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findMention,
  findMentions,
  insertMention,
  justOpenedMention,
  splitMentions,
} from '../src/lib/mention';

test('a freshly typed @ opens the picker', () => {
  assert.ok(justOpenedMention('fix @', 5));
  assert.ok(justOpenedMention('@', 1), 'even as the first character');
  assert.ok(justOpenedMention('look at (\n@', 11));
  assert.ok(!justOpenedMention('me@', 3), 'an email is not a file reference');
  assert.ok(!justOpenedMention('user@', 5));
  assert.ok(!justOpenedMention('fix a', 5), 'only @ opens it');
});

test('the token under the caret is what gets replaced', () => {
  const text = 'refactor @src/lib/cl';
  const m = findMention(text, text.length);
  assert.deepEqual(m, { start: 9, end: 20, query: 'src/lib/cl' });
});

test('an @ inside a word is not a token', () => {
  const text = 'mail me@server now';
  assert.equal(findMention(text, 11), null);
});

test('a token ends at whitespace, so the caret never reaches across words', () => {
  assert.equal(findMention('read @a.ts then @b.ts', 12), null);
  const m = findMention('read @a.ts then @b.ts', 21);
  assert.deepEqual(m, { start: 16, end: 21, query: 'b.ts' });
});

test('a token survives punctuation that ends it', () => {
  assert.deepEqual(findMention('see (@a.ts)', 10), { start: 5, end: 10, query: 'a.ts' });
  assert.equal(findMention('see (@a.ts)', 11), null, 'past the closing paren there is no token');
});

test('picking a file replaces the token and parks the caret after it', () => {
  const text = 'refactor @src/lib/cl please';
  const m = findMention(text, text.length - ' please'.length)!;
  const out = insertMention(text, m, 'src/lib/clip.ts');
  assert.equal(out.text, 'refactor @src/lib/clip.ts please');
  assert.equal(out.caret, 'refactor @src/lib/clip.ts '.length);
});

test('a reference inserted into running text keeps its spaces', () => {
  const out = insertMention('explain this', { start: 12, end: 12 }, 'docs/a.md');
  assert.equal(out.text, 'explain this @docs/a.md ');
  assert.equal(out.caret, out.text.length);

  const atStart = insertMention('', { start: 0, end: 0 }, 'a.ts');
  assert.equal(atStart.text, '@a.ts ');
});

test('a directory reference keeps its trailing slash and gets no double space', () => {
  const out = insertMention('look in @src/', { start: 8, end: 13 }, 'src/');
  assert.equal(out.text, 'look in @src/ ');
  assert.equal(out.caret, out.text.length, 'typing continues after the reference');
});

test('the references in a finished message are readable back out', () => {
  assert.deepEqual(
    findMentions('compare @src/a.ts with @docs/spec.md and @server/ please'),
    ['src/a.ts', 'docs/spec.md', 'server/']
  );
  assert.deepEqual(findMentions('mail me@example.com'), []);
  assert.deepEqual(findMentions('@ alone means nothing'), []);
});

test('a message splits into text and references', () => {
  assert.deepEqual(splitMentions('read @src/a.ts now'), [
    { text: 'read ', mention: false },
    { text: '@src/a.ts', mention: true },
    { text: ' now', mention: false },
  ]);
  assert.deepEqual(splitMentions('nothing here'), [{ text: 'nothing here', mention: false }]);
  assert.deepEqual(splitMentions(''), []);
  assert.deepEqual(splitMentions('@ alone is not a path'), [{ text: '@ alone is not a path', mention: false }]);
  // Reassembling must give back exactly what went in, spaces included.
  const text = 'compare @a.ts and @b/c.md, then @dir/ please';
  assert.equal(splitMentions(text).map((s) => s.text).join(''), text);
});
