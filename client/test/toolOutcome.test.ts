import test from 'node:test';
import assert from 'node:assert/strict';
import { rowKey, rowsToItems, toolFailed, type Item } from '../src/lib/items';
import type { MessageRow } from '../src/api';
import { applyEvent, initialTurnState } from '../src/lib/chatEvents';

// Failure detection used to be `result.startsWith('error')` in two components.
// It is one function now, driven by an explicit flag, with the old wording kept
// only as a fallback for history written before the flag existed.

test('a running tool is never a failure', () => {
  assert.equal(toolFailed({}), false);
  assert.equal(toolFailed({ result: undefined, ok: false }), false);
});

test('the explicit flag wins over the wording', () => {
  assert.equal(toolFailed({ result: 'boom', ok: false }), true);
  // A tool that legitimately prints something starting with "error" is fine.
  assert.equal(toolFailed({ result: 'error.log: 3 lines read', ok: true }), false);
});

test('rows from before the flag still read their wording', () => {
  assert.equal(toolFailed({ result: 'error: no such file' }), true);
  assert.equal(toolFailed({ result: 'file listing' }), false);
});

test('tool.result carries the outcome onto the item', () => {
  let state = initialTurnState();
  state = applyEvent(state, { type: 'tool.start', id: 'c1', name: 'bash', args: { command: 'false' } });
  state = applyEvent(state, { type: 'tool.result', id: 'c1', name: 'bash', result: '[exit code 1]' });
  assert.notEqual((state.items[0] as Extract<Item, { kind: 'tool' }>).ok, false);

  state = applyEvent(state, { type: 'tool.start', id: 'c2', name: 'bash', args: {} });
  state = applyEvent(state, { type: 'tool.result', id: 'c2', name: 'bash', result: 'nope', ok: false });
  assert.equal((state.items[1] as Extract<Item, { kind: 'tool' }>).ok, false);
});

test('a result for an unknown call id leaves the state alone', () => {
  const state = initialTurnState();
  assert.equal(applyEvent(state, { type: 'tool.result', id: 'nope', name: 'bash', result: 'x' }), state);
});

test('history rows restore the stored outcome', () => {
  const rows: MessageRow[] = [
    {
      id: 1,
      session_id: 's',
      seq: 1,
      role: 'tool',
      content: '[exit code 1]',
      meta: JSON.stringify({ tool_call_id: 'c1', name: 'bash', ok: false }),
    },
    {
      id: 2,
      session_id: 's',
      seq: 2,
      role: 'tool',
      content: 'error: old style failure',
      meta: JSON.stringify({ tool_call_id: 'c2', name: 'bash' }),
    },
  ];
  const items = rowsToItems(rows);
  assert.equal(toolFailed(items[0] as { result?: string; ok?: boolean }), true);
  assert.equal(toolFailed(items[1] as { result?: string; ok?: boolean }), true);
});

test('a tool card keeps its identity between live and reopened history', () => {
  // Live: the id comes from the stream.
  let state = applyEvent(initialTurnState(), { type: 'tool.start', id: 'call_9', name: 'bash', args: {} });
  // Reopened: the same id must come back out of the stored meta, not the row id.
  const reopened = rowsToItems([
    {
      id: 41,
      session_id: 's',
      seq: 3,
      role: 'tool',
      content: 'ok',
      meta: JSON.stringify({ tool_call_id: 'call_9', name: 'bash' }),
    },
  ]);
  assert.equal((state.items[0] as Extract<Item, { kind: 'tool' }>).id, 'call_9');
  assert.equal((reopened[0] as Extract<Item, { kind: 'tool' }>).id, 'call_9');
});

test('rows without a stored call id still get a usable key', () => {
  const items = rowsToItems([
    { id: 7, session_id: 's', seq: 1, role: 'tool', content: 'ok', meta: JSON.stringify({ name: 'bash' }) },
  ]);
  assert.equal(rowKey(items[0]!, 0), 'tool:7');
});
