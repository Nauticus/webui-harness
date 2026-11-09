import test from 'node:test';
import assert from 'node:assert/strict';
import { clipText, OUTPUT_BUDGET } from '../src/lib/clip';

test('output that fits is shown whole', () => {
  for (const text of ['', 'one line', 'a\nb\nc', 'a\n']) {
    const c = clipText(text);
    assert.equal(c.clipped, false, text);
    assert.equal(c.hidden, 0, text);
    assert.equal(c.shown, text, text);
  }
});

test('the cut is at a line boundary and the rest is counted', () => {
  const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const c = clipText(text, { lines: 5, chars: 1e6 });
  assert.equal(c.shown, ['line 0', 'line 1', 'line 2', 'line 3', 'line 4'].join('\n'));
  assert.equal(c.hidden, 35);
  assert.equal(c.clipped, true);
});

test('a line that fits the budget is never split, so it stays parseable', () => {
  const c = clipText(['const a = 1;', 'x'.repeat(50), 'const b = 2;'].join('\n'), { lines: 2, chars: 1000 });
  assert.equal(c.hidden, 1);
  assert.equal(c.shown.split('\n').length, 2);
  assert.ok(c.shown.endsWith('x'), 'the last shown line is whole');
});

test('the character budget stops at a line boundary, never inside one', () => {
  const c = clipText(`short\n${'x'.repeat(5000)}\ntail`, { lines: 3, chars: 100 });
  assert.equal(c.shown, 'short');
  assert.equal(c.hidden, 2);
  assert.equal(c.clipped, true);
});

test('one enormous line still shows its beginning instead of nothing', () => {
  const c = clipText('x'.repeat(50_000), { lines: 14, chars: 1000 });
  assert.equal(c.shown.length, 1000);
  assert.equal(c.clipped, true);
});

test('the budget applies to the whole block, not per line', () => {
  const text = Array.from({ length: 12 }, () => 'y'.repeat(300)).join('\n');
  const c = clipText(text, { lines: 12, chars: 1000 });
  assert.ok(c.shown.length <= 1000, `shown ${c.shown.length} chars over budget`);
  assert.ok(c.hidden > 0);
});

test('the default budget is what the cards were sized for', () => {
  assert.ok(OUTPUT_BUDGET.lines >= 10 && OUTPUT_BUDGET.lines <= 24);
  assert.ok(OUTPUT_BUDGET.chars >= 1000);
});
