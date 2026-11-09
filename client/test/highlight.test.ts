import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  languageFromPath,
  segmentsByLine,
  segmentsFromTree,
  segmentsText,
  type Segment,
  type SyntaxNode,
} from '../src/lib/highlight-core';

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

test('a file path picks its grammar by extension', () => {
  assert.equal(languageFromPath('src/lib/items.ts'), 'ts');
  assert.equal(languageFromPath('/a/b/App.tsx'), 'tsx');
  assert.equal(languageFromPath('scripts/deploy.sh'), 'bash');
  assert.equal(languageFromPath('main.py'), 'python');
  assert.equal(languageFromPath('style.css'), 'css');
  assert.equal(languageFromPath('nested/dir/main.rs'), 'rust');
});

test('unknown or absent extensions mean plain text', () => {
  for (const p of ['README.md', 'package.json', 'data.yaml', 'Makefile', '.bashrc', '', '.', 'src']) {
    assert.equal(languageFromPath(p), undefined, p);
  }
});

test('segments split into lines without losing text', () => {
  const segs: Segment[] = [
    { text: 'const a = 1;\nconst b', cls: undefined },
    { text: ' = ', cls: 'operator' },
    { text: '2;\n', cls: 'number' },
  ];
  const lines = segmentsByLine(segs);
  assert.equal(lines.length, 3);
  assert.equal(lines.map((l) => l.map((s) => s.text).join('')).join('\n'), 'const a = 1;\nconst b = 2;\n');
  assert.deepEqual(lines[1], [
    { text: 'const b', cls: undefined },
    { text: ' = ', cls: 'operator' },
    { text: '2;', cls: 'number' },
  ]);
  assert.deepEqual(lines[2], []); // the trailing newline ends the block
});

test('an empty block is one empty line', () => {
  assert.deepEqual(segmentsByLine([]), [[]]);
});

/** A node of a given type, laid out in source order. */
function n(type: string, children: SyntaxNode[], start = children.length ? children[0]!.startIndex : 0): SyntaxNode {
  return { type, startIndex: start, endIndex: children[children.length - 1]!.endIndex, isNamed: true, isError: false, children };
}

test('a shell command names its program, not its arguments', () => {
  const name = leaf('word', 'git', 0);
  const sub = leaf('word', 'commit', 4);
  const flag = leaf('word', '-am', 11);
  const str = n('string', [leaf('"', '"', 15, false), leaf('string_content', 'fix', 16), leaf('"', '"', 19, false)], 15);
  const source = 'git commit -am "fix"';
  const tree = n('command', [n('command_name', [name]), sub, flag, str]);
  const segments = segmentsFromTree(tree, source);
  assert.equal(segmentsText(segments), source, 'colouring must not change the text');
  assert.deepEqual(segments, [
    { text: 'git', cls: 'command' },
    { text: ' commit ', cls: undefined },
    { text: '-am', cls: 'flag' },
    // the quotes are anonymous tokens with no colour of their own, so they sit
    // in the plain run either side of the string's content
    { text: ' "', cls: undefined },
    { text: 'fix', cls: 'string' },
    { text: '"', cls: undefined },
  ]);
});

test('a flag is only a flag inside a command', () => {
  const bare = segmentsFromTree(node([leaf('word', '-x', 0)]), '-x');
  assert.deepEqual(bare, [{ text: '-x', cls: undefined }]);
});

test('a flag needs a letter, so `-1` and `--` stay plain', () => {
  for (const t of ['-1', '--', '-', '—-']) {
    const segs = segmentsFromTree(n('command', [n('command_name', [leaf('word', 'cat', 0)]), leaf('word', t, 4)]), `cat ${t}`);
    assert.equal(segs.some((s) => s.cls === 'flag'), false, t);
  }
});

test('a second command in a pipeline is coloured on its own terms', () => {
  const a = n('command', [n('command_name', [leaf('word', 'ls', 0)]), leaf('word', '-la', 3)], 0);
  const pipe = leaf('|', '|', 7, false);
  const b = n('command', [n('command_name', [leaf('word', 'grep', 9)]), leaf('word', '-c', 14)], 9);
  const source = 'ls -la | grep -c';
  const segments = segmentsFromTree(n('list', [a, pipe, b]), source);
  assert.equal(segmentsText(segments), source);
  assert.deepEqual(segments.filter((s) => s.cls), [
    { text: 'ls', cls: 'command' },
    { text: '-la', cls: 'flag' },
    { text: '|', cls: 'operator' },
    { text: 'grep', cls: 'command' },
    { text: '-c', cls: 'flag' },
  ]);
});

test('a non-shell tree is untouched by the shell rules', () => {
  const { source, leaves } = src('const', ' x', ' ', '=', ' ', 'foo', '(', '1', ')', ';');
  const before = segmentsFromTree(node(leaves), source);
  assert.ok(before.every((s) => s.cls !== 'command' && s.cls !== 'flag'));
});
