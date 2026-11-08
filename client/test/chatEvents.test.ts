import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, settleCompaction, withStopped, initialTurnState, type TurnState } from '../src/lib/chatEvents';
import type { Item } from '../src/lib/items';
import type { ServerEvent } from '../src/api';

const ev = (e: Record<string, unknown>): ServerEvent => e as ServerEvent;

const st = (over: Partial<TurnState> = {}): TurnState => ({ ...initialTurnState(), ...over });

const assistant = (content: string): Item => ({ kind: 'assistant', content });
const thinking = (content: string, done = false): Item => ({ kind: 'thinking', content, done });

test('message.delta: appends to the last assistant item', () => {
  const s = applyEvent(st({ items: [assistant('hel')] }), ev({ type: 'message.delta', text: 'lo' }));
  assert.deepEqual(s.items, [assistant('hello')]);
  assert.equal(s.streamed, true);
});

test('message.delta: creates an assistant item when there is none', () => {
  const s = applyEvent(st(), ev({ type: 'message.delta', text: 'hi' }));
  assert.deepEqual(s.items, [assistant('hi')]);
});

test('message.delta: settles an open thinking block first', () => {
  const s = applyEvent(st({ items: [thinking('why')] }), ev({ type: 'message.delta', text: 'x' }));
  assert.deepEqual(s.items, [thinking('why', true), assistant('x')]);
});

test('thinking.delta: appends to an open thinking block', () => {
  const s = applyEvent(st({ items: [thinking('th')] }), ev({ type: 'thinking.delta', text: 'ink' }));
  assert.deepEqual(s.items, [thinking('think')]);
});

test('thinking.delta: starts a new block when the last one is done', () => {
  const s = applyEvent(st({ items: [thinking('old', true)] }), ev({ type: 'thinking.delta', text: 'new' }));
  assert.deepEqual(s.items, [thinking('old', true), thinking('new')]);
});

test('tool.start: settles thinking and appends the tool card', () => {
  const s = applyEvent(st({ items: [thinking('t')] }), ev({ type: 'tool.start', id: 'c1', name: 'bash', args: { command: 'ls' } }));
  assert.deepEqual(s.items, [thinking('t', true), { kind: 'tool', id: 'c1', name: 'bash', args: { command: 'ls' } }]);
});

test('tool.result: updates the matching tool card (with diff)', () => {
  const s = applyEvent(
    st({ items: [{ kind: 'tool', id: 'c1', name: 'bash' }] }),
    ev({ type: 'tool.result', id: 'c1', name: 'bash', result: 'ok', diff: '+x' })
  );
  assert.deepEqual(s.items, [{ kind: 'tool', id: 'c1', name: 'bash', result: 'ok', diff: '+x' }]);
});

test('tool.result: ignores unmatched ids', () => {
  const items = [{ kind: 'tool', id: 'c1', name: 'bash' }];
  const s = applyEvent(st({ items }), ev({ type: 'tool.result', id: 'other', name: 'bash', result: 'ok' }));
  assert.deepEqual(s.items, items);
});

test('message.complete: appends content only when nothing streamed', () => {
  const streamed = applyEvent(st({ items: [assistant('hi')], streamed: true }), ev({ type: 'message.complete', content: 'hi', tokens: 5 }));
  assert.deepEqual(streamed.items, [assistant('hi')]);
  const notStreamed = applyEvent(st({ items: [] }), ev({ type: 'message.complete', content: 'full', tokens: 5 }));
  assert.deepEqual(notStreamed.items, [assistant('full')]);
});

test('message.complete: refines context tokens only when a context exists', () => {
  const withCtx = applyEvent(
    st({ context: { tokens: 1, window: 10, threshold: 5 } }),
    ev({ type: 'message.complete', content: '', tokens: 9 })
  );
  assert.equal(withCtx.context?.tokens, 9);
  const noCtx = applyEvent(st(), ev({ type: 'message.complete', content: '', tokens: 9 }));
  assert.equal(noCtx.context, null);
});

test('message.stopped: appends the stopped marker and partial content when not streamed', () => {
  const s = applyEvent(st(), ev({ type: 'message.stopped', content: 'part', tokens: 3 }));
  assert.deepEqual(s.items, [assistant('part'), { kind: 'stopped' }]);
  const streamed = applyEvent(st({ items: [assistant('part')], streamed: true }), ev({ type: 'message.stopped', content: 'part', tokens: 3 }));
  assert.deepEqual(streamed.items, [assistant('part'), { kind: 'stopped' }]);
});

test('the stop marker is appended once (abort and a late event meet)', () => {
  const aborted = withStopped(st({ items: [assistant('part')] }));
  assert.deepEqual(aborted.items, [assistant('part'), { kind: 'stopped' }]);
  // The server's message.stopped arrives after abort() already marked it.
  const late = applyEvent(aborted, ev({ type: 'message.stopped', content: '' }));
  assert.deepEqual(late.items, [assistant('part'), { kind: 'stopped' }]);
  assert.equal(withStopped(late).items.length, 2);
});

test('error: appends an error item', () => {
  const s = applyEvent(st(), ev({ type: 'error', message: 'boom' }));
  assert.deepEqual(s.items, [{ kind: 'error', message: 'boom' }]);
});

test('compaction lifecycle: start -> progress -> done (fills the running card, keeps tokensOut)', () => {
  let s = applyEvent(st(), ev({ type: 'compaction.start', tokensBefore: 100 }));
  assert.equal(s.items.at(-1)?.kind, 'compaction');
  s = applyEvent(s, ev({ type: 'compaction.progress', tokensOut: 7 }));
  s = applyEvent(s, ev({ type: 'compaction', summary: 'sum', firstKeptSeq: 2, tokensBefore: 100, tokensAfter: 20 }));
  assert.deepEqual(s.items, [
    { kind: 'compaction', status: 'done', summary: 'sum', tokensBefore: 100, tokensAfter: 20, tokensOut: 7 },
  ]);
});

test('compaction done without a start event adds a fresh card', () => {
  const s = applyEvent(st(), ev({ type: 'compaction', summary: 'sum', firstKeptSeq: 2, tokensBefore: 100, tokensAfter: 20 }));
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0]!.kind, 'compaction');
  assert.equal((s.items[0] as { status?: string }).status, 'done');
});

test('compaction progress without a running card is a no-op', () => {
  const s = applyEvent(st(), ev({ type: 'compaction.progress', tokensOut: 7 }));
  assert.deepEqual(s.items, []);
});

test('context: sets the context usage', () => {
  const s = applyEvent(st(), ev({ type: 'context', tokens: 11, window: 22, threshold: 13 }));
  assert.deepEqual(s.context, { tokens: 11, window: 22, threshold: 13 });
});

test('unknown event types are ignored', () => {
  const s = applyEvent(st({ items: [assistant('x')] }), ev({ type: 'something.new' }));
  assert.deepEqual(s.items, [assistant('x')]);
});

test('settleCompaction: settles running cards (interrupted turn)', () => {
  const s = settleCompaction(
    applyEvent(st(), ev({ type: 'compaction.start', tokensBefore: 100 }))
  );
  assert.deepEqual(s.items, [{ kind: 'compaction', status: 'done', tokensBefore: 100 }]);
});

test('a delta with no text adds nothing rather than "undefined"', () => {
  const s = applyEvent(st({ items: [assistant('hi')] }), ev({ type: 'message.delta' } as never));
  assert.deepEqual(s.items, [assistant('hi')]);
  const t = applyEvent(st({ items: [{ kind: 'thinking', content: 'th', done: false }] }), ev({ type: 'thinking.delta' } as never));
  assert.deepEqual(t.items, [{ kind: 'thinking', content: 'th', done: false }]);
});
