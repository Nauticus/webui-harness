import test from 'node:test';
import assert from 'node:assert/strict';
import { isAwaitingModel, rowKey, toRows, type ChatRow, type Item } from '../src/lib/items';

const user: Item = { kind: 'user', content: 'hi' };
const assistant = (content = 'x'): Item => ({ kind: 'assistant', content });
const thinking = (done: boolean): Item => ({ kind: 'thinking', content: 'th', done });
const tool = (done: boolean): Item =>
  done ? { kind: 'tool', id: '1', name: 'bash', result: 'ok' } : { kind: 'tool', id: '1', name: 'bash' };
const compaction = (status: 'running' | 'done'): Item => ({ kind: 'compaction', status });
const busyRow: ChatRow = { kind: 'busy' };

test('never shows the placeholder while no turn is running', () => {
  for (const items of [[], [user], [assistant()], [tool(true)]]) {
    assert.equal(isAwaitingModel(items, false), false);
    assert.deepEqual(toRows(items, false), items);
  }
});

test('shows the placeholder for every silent gap in a running turn', () => {
  assert.equal(isAwaitingModel([], true), true); // first turn, nothing on screen
  assert.equal(isAwaitingModel([user], true), true); // waiting for the first token
  assert.equal(isAwaitingModel([user, thinking(true)], true), true); // thinking settled, answer pending
  assert.equal(isAwaitingModel([user, tool(true)], true), true); // round finished, next call in flight
  assert.equal(isAwaitingModel([compaction('done')], true), true); // compacted, then the model
});

test('stays out of the way while something is visibly streaming', () => {
  assert.equal(isAwaitingModel([assistant('partial')], true), false); // text streaming
  assert.equal(isAwaitingModel([thinking(false)], true), false); // thinking streaming
  assert.equal(isAwaitingModel([tool(false)], true), false); // tool card says "running"
  assert.equal(isAwaitingModel([compaction('running')], true), false); // compaction card pulses
  assert.equal(isAwaitingModel([user, { kind: 'error', message: 'boom' }], true), false);
  assert.equal(isAwaitingModel([{ kind: 'stopped' }], true), false);
});

test('toRows appends the placeholder as an extra row, leaving items alone', () => {
  const items = [user, tool(true)];
  assert.deepEqual(toRows(items, true), [...items, busyRow]);
  assert.deepEqual(items, [user, tool(true)]); // not mutated
});

test('row keys: tools key on their call id, everything else on position', () => {
  assert.equal(rowKey({ kind: 'busy' }, 3), 'busy');
  assert.equal(rowKey({ kind: 'tool', id: 'c1', name: 'bash' }, 3), 'tool:c1');
  assert.equal(rowKey({ kind: 'user', content: 'hi' }, 3), 'user:3');
  assert.equal(rowKey({ kind: 'assistant', content: 'x' }, 3), 'assistant:3');
});
