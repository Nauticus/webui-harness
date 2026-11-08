import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, segmentsFromTree, segmentsText, type SyntaxNode } from '../src/lib/highlight-core';

/** A tree-sitter node, as far as the colouring rules care. Anonymous tokens
 *  carry their literal text as their type, which is what the rules key on. */
function leaf(type: string, text: string, start: number, named = true): SyntaxNode {
  return { type, startIndex: start, endIndex: start + text.length, isNamed: named, isError: false, children: [] };
}
function node(children: SyntaxNode[], start = 0, end = children.length ? children[children.length - 1]!.endIndex : 0): SyntaxNode {
  return { type: 'program', startIndex: start, endIndex: end, isNamed: true, isError: false, children };
}
function src(...parts: string[]): { source: string; leaves: SyntaxNode[] } {
  let pos = 0;
  const leaves = parts.map((t) => {
    const isKeyword = /^[a-z][a-z0-9_]*$/.test(t) && !/^\s/.test(t) && !/[;(){}+\-=/&|<>,."']/.test(t);
    const named = !isKeyword && !/[;(){}+\-=/&|<>,."']/.test(t);
    const l = leaf(isKeyword ? t : named ? 'identifier' : t, t, pos, named);
    pos += t.length;
    return l;
  });
  return { source: parts.join(''), leaves };
}

test('colouring never changes the text', () => {
  const { source, leaves } = src('const', ' x', ' ', '=', ' ', 'foo', '(', '1', ')', ';');
  const segments = segmentsFromTree(node(leaves), source);
  assert.equal(segmentsText(segments), source);
});

test('whitespace and gaps stay plain', () => {
  const a = leaf('identifier', 'a', 0);
  const b = leaf('identifier', 'b', 2);
  const segments = segmentsFromTree(node([a, b]), 'a b');
  // both identifiers and the gap are uncoloured, so they collapse into one run
  assert.deepEqual(segments, [{ text: 'a b', cls: undefined }]);
});

test('a coloured token splits the plain runs around it', () => {
  const a = leaf('identifier', 'a', 0);
  const kw = leaf('return', 'return', 2, false);
  const segments = segmentsFromTree(node([a, kw]), 'a return');
  assert.deepEqual(segments, [
    { text: 'a ', cls: undefined },
    { text: 'return', cls: 'keyword' },
  ]);
});

test('keywords are the word-shaped anonymous tokens', () => {
  assert.equal(classify(leaf('if', 'if', 0, false)), 'keyword');
  assert.equal(classify(leaf('function', 'function', 0, false)), 'keyword');
  assert.equal(classify(leaf('def', 'def', 0, false)), 'keyword');
});

test('operators get a shade, delimiters stay plain', () => {
  for (const t of ['=>', '&&', '===', '=', '+=', '|']) assert.equal(classify(leaf(t, t, 0, false)), 'operator', t);
  // one span per bracket and comma would triple the DOM for no gain in reading
  for (const t of [';', ',', '(', ')', '{', '}', '.']) assert.equal(classify(leaf(t, t, 0, false)), undefined, t);
});

test('conventions shared across grammars map to tokens', () => {
  assert.equal(classify(leaf('comment', '// hi', 0)), 'comment');
  assert.equal(classify(leaf('string_content', 'hi', 0)), 'string');
  assert.equal(classify(leaf('string_fragment', 'hi', 0)), 'string');
  assert.equal(classify(leaf('escape_sequence', '\\n', 0)), 'escape');
  assert.equal(classify(leaf('number', '42', 0)), 'number');
  assert.equal(classify(leaf('integer', '42', 0)), 'number');
  assert.equal(classify(leaf('float', '4.2', 0)), 'number');
  assert.equal(classify(leaf('property_identifier', 'x', 0)), 'property');
  assert.equal(classify(leaf('type_identifier', 'Foo', 0)), 'type');
  assert.equal(classify(leaf('true', 'true', 0)), 'constant');
  assert.equal(classify(leaf('none', 'None', 0)), 'constant');
});

test('identifiers and arguments are left alone', () => {
  // Colouring every identifier would turn a normal block of code into confetti.
  for (const t of ['identifier', 'word', 'variable_name', 'formal_parameters']) {
    assert.equal(classify(leaf(t, 'x', 0)), undefined, t);
  }
});

test('a parse error is visible but not loud', () => {
  const bad = leaf('ERROR', '???', 0);
  (bad as { isError: boolean }).isError = true;
  assert.equal(classify(bad), 'error');
});

test('adjacent runs of the same kind merge', () => {
  const a = leaf('string_content', 'a', 0);
  const b = leaf('string_content', 'b', 1);
  const segments = segmentsFromTree(node([a, b]), 'ab');
  assert.deepEqual(segments, [{ text: 'ab', cls: 'string' }]);
});
