import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  estimateContextTokens,
  calculateContextTokens,
  findCutPoint,
  serializeSpan,
  summaryAsMessage,
  firstKeptSeqOf,
  toLlmMessages,
  compactionThreshold,
  latestCompactionSeq,
  RESERVE_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  KEEP_RECENT_TOKENS,
  type CompactableMessage,
} from '../src/compaction';
import type { HistoryRecord } from '../src/history';

const user = (text: string, seq?: number): CompactableMessage => ({ role: 'user', content: text, ...(seq !== undefined ? { seq } : {}) });
const asst = (text: string, seq?: number): CompactableMessage => ({ role: 'assistant', content: text, ...(seq !== undefined ? { seq } : {}) });
const callMsg = (id: string, name: string, args: object, seq?: number): CompactableMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  ...(seq !== undefined ? { seq } : {}),
});
const toolMsg = (id: string, name: string, output: string, seq?: number): CompactableMessage => ({
  role: 'tool',
  tool_call_id: id,
  name,
  content: output,
  ...(seq !== undefined ? { seq } : {}),
});

test('compactionThreshold: per-model window wins, else env/default fallback', () => {
  // Clamped at 0: a window smaller than the reserve always compacts.
  assert.equal(compactionThreshold(5000), Math.max(0, 5000 - RESERVE_TOKENS));
  assert.equal(compactionThreshold(200_000), 200_000 - RESERVE_TOKENS);
  assert.equal(compactionThreshold(undefined), DEFAULT_CONTEXT_WINDOW - RESERVE_TOKENS);
  assert.equal(compactionThreshold(0), DEFAULT_CONTEXT_WINDOW - RESERVE_TOKENS);
  assert.equal(compactionThreshold(-1), DEFAULT_CONTEXT_WINDOW - RESERVE_TOKENS);
});

test('estimateTokens scales roughly with content size', () => {
  const small = estimateTokens([user('hello')]);
  const big = estimateTokens([user('x'.repeat(40_000))]);
  assert.ok(small < 50);
  assert.ok(big > 9_000 && big < 11_000); // ~10k tokens for 40k chars
});

test('findCutPoint: tiny conversation has nothing to summarize', () => {
  const msgs = [user('hi'), asst('hello')];
  assert.equal(findCutPoint(msgs).cut, 0);
});

test('findCutPoint: keeps the tail worth ~KEEP_RECENT_TOKENS', () => {
  const n = 20;
  const msgs = Array.from({ length: n }, (_, i) => user(`${i} ${'word '.repeat(2000)}`)); // ~5k tokens each
  const { cut } = findCutPoint(msgs);
  const keptTokens = estimateTokens(msgs.slice(cut));
  assert.ok(cut > 0 && cut < n, `cut=${cut}`);
  assert.ok(keptTokens >= KEEP_RECENT_TOKENS * 0.9, `kept=${keptTokens}`);
});

test('findCutPoint: a mid-turn cut is a split turn pointing at the turn start', () => {
  const msgs = [
    user('earlier work'),
    asst('earlier done'),
    user('big task'),
    asst('reading'),
    callMsg('call_1', 'read_file', { path: 'a.ts' }),
    toolMsg('call_1', 'read_file', 'x'.repeat(120_000)), // ~30k tokens on its own
  ];
  const cp = findCutPoint(msgs);
  assert.ok(cp.isSplitTurn, 'a cut mid-turn is a split turn');
  assert.equal(cp.turnStart, 2, 'turnStart is the user message that started the turn');
  assert.ok(cp.cut > cp.turnStart && cp.cut < msgs.length, `cut=${cp.cut}`);
  // The kept span never starts with a tool result.
  assert.ok(msgs[cp.cut]!.role !== 'tool');
});

test('findCutPoint: a cut at a turn start is not a split turn', () => {
  const msgs = [
    user(`one ${'word '.repeat(3000)}`), // ~7.5k tokens each
    user(`two ${'word '.repeat(3000)}`),
    user(`three ${'word '.repeat(3000)}`),
  ];
  const cp = findCutPoint(msgs);
  assert.ok(!cp.isSplitTurn);
  assert.equal(cp.turnStart, -1);
  assert.equal(msgs[cp.cut]!.role, 'user');
});

test('findCutPoint: never orphans a tool result from its tool call', () => {
  const msgs = [
    user('do stuff'),
    asst('reading'),
    callMsg('call_1', 'read_file', { path: 'a.ts' }),
    toolMsg('call_1', 'read_file', 'x'.repeat(60_000)), // big tool result
    user('thanks'),
    asst('done!'),
  ];
  const { cut } = findCutPoint(msgs);
  // If the raw backwards walk stops at the tool result, back up to its call.
  assert.ok(msgs[cut]!.role !== 'tool');
  if (cut === 3) assert.fail('cut lands on the tool result');
  // The kept span, if it includes any tool message, also includes its call.
  const kept = msgs.slice(cut);
  const firstToolIdx = kept.findIndex((m) => m.role === 'tool');
  if (firstToolIdx !== -1) {
    assert.ok(kept[firstToolIdx - 1]!.role === 'assistant' && kept[firstToolIdx - 1]!.tool_calls?.length);
  }
});

test('firstKeptSeqOf: seq-based cut keeps that record onward', () => {
  const messages = [user('old', 1), user('new', 2), asst('ok', 3)];
  assert.equal(firstKeptSeqOf(messages, [messages[2]!]), 2); // keep seq > 2
});

test('firstKeptSeqOf: mid-turn cut means all persisted records were summarized', () => {
  const messages = [user('old', 1), user('new', 2), callMsg('c', 'bash', { command: 'ls' }), toolMsg('c', 'bash', 'out')];
  const rest = [messages[2]!, messages[3]!]; // first kept message has no seq
  assert.equal(firstKeptSeqOf(messages, rest), 2); // keep only records with seq > 2
});

test('serializeSpan: flat labels, truncated tool results, key=value tool-call args (pi format)', () => {
  const long = 'y'.repeat(10_000);
  const text = serializeSpan([
    user('do the thing'),
    asst('on it'),
    callMsg('c1', 'edit_file', { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }),
    toolMsg('c1', 'edit_file', long),
  ]);
  assert.ok(text.includes('[User]: do the thing'));
  assert.ok(text.includes('[Assistant]: on it'));
  // pi's argument formatting: key=JSON.stringify(value) pairs.
  assert.ok(text.includes('[Assistant tool calls]: edit_file(path="a.ts", edits=[{"oldText":"a","newText":"b"}])'));
  assert.ok(text.includes('[Tool result]: '));
  assert.ok(text.includes('8000 more characters truncated'));
  assert.ok(!text.includes('y'.repeat(5000))); // truncated, not full content
});

test('serializeSpan: empty content is skipped, malformed args fall back to empty', () => {
  const text = serializeSpan([
    { role: 'user', content: '' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: 'not-json' } }],
    },
  ]);
  assert.ok(!text.includes('[User]: '));
  assert.ok(text.includes('[Assistant tool calls]: bash()'));
});

test('summaryAsMessage + toLlmMessages: compaction record trims old records', () => {
  const rows: HistoryRecord[] = [
    { seq: 1, role: 'user', content: 'first request' },
    { seq: 2, role: 'assistant', content: 'first answer' },
    { seq: 3, role: 'compaction', content: '## Goal\ndo the thing', meta: { firstKeptSeq: 2 } },
    { seq: 4, role: 'user', content: 'second request' },
    {
      seq: 5,
      role: 'assistant',
      content: null,
      meta: { tool_calls: [{ id: 'c', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
    },
    { seq: 6, role: 'tool', content: 'file.txt', meta: { tool_call_id: 'c', name: 'bash' } },
  ];
  const msgs = toLlmMessages(rows);
  assert.equal(msgs[0]!.role, 'user');
  assert.ok(msgs[0]!.content?.includes('## Goal'));
  assert.ok(msgs[0]!.content?.startsWith('CONTEXT SUMMARY'));
  // seq 1-2 summarized away; 3 is the compaction record itself (not a message).
  // The summary message itself has no seq.
  const seqs = msgs.map((m) => m.seq);
  assert.deepEqual(seqs, [undefined, 4, 5, 6]);
  assert.equal(msgs[3]!.role, 'tool');
  assert.equal(msgs[3]!.content, 'file.txt');
});

test('toLlmMessages: without a compaction record all rows flow through', () => {
  const rows: HistoryRecord[] = [
    { seq: 1, role: 'user', content: 'a' },
    { seq: 2, role: 'assistant', content: 'b' },
  ];
  const msgs = toLlmMessages(rows);
  assert.deepEqual(msgs.map((m) => m.seq), [1, 2]);
});

test('toLlmMessages: the latest compaction record wins', () => {
  const rows: HistoryRecord[] = [
    { seq: 1, role: 'user', content: 'one' },
    { seq: 2, role: 'compaction', content: 'old summary', meta: { firstKeptSeq: 1 } },
    { seq: 3, role: 'user', content: 'three' },
    { seq: 4, role: 'compaction', content: 'new summary', meta: { firstKeptSeq: 3 } },
    { seq: 5, role: 'user', content: 'five' },
  ];
  const msgs = toLlmMessages(rows);
  assert.ok(msgs[0]!.content?.includes('new summary'));
  assert.ok(!msgs[0]!.content?.includes('old summary'));
  assert.deepEqual(msgs.map((m) => m.seq), [undefined, 5]);
});

// ---------- usage-anchored token accounting (pi hybrid) ----------

test('calculateContextTokens: native total wins, else component sum', () => {
  assert.equal(calculateContextTokens({ input: 10, output: 5, totalTokens: 20 }), 20);
  assert.equal(calculateContextTokens({ input: 10, output: 5 }), 15);
  assert.equal(calculateContextTokens({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2 }), 20);
});

test('estimateContextTokens: without usage it is the plain estimate', () => {
  const messages: CompactableMessage[] = [
    { role: 'user', content: 'hello world' },
    { role: 'assistant', content: 'hi there' },
  ];
  assert.equal(estimateContextTokens(messages), estimateTokens(messages));
});

test('estimateContextTokens: usage anchor + trailing estimate', () => {
  const messages: CompactableMessage[] = [
    { role: 'user', content: 'x'.repeat(4000) },
    { role: 'assistant', content: 'y'.repeat(4000), usage: { input: 1000, output: 500 } },
    { role: 'tool', content: 'z'.repeat(4000), tool_call_id: 't1', name: 'bash' },
  ];
  // 1500 (usage) + chars/4 of the trailing tool message (1000 + overhead).
  const trailing = estimateTokens([messages[2]!]);
  assert.equal(estimateContextTokens(messages), 1500 + trailing);
  assert.ok(estimateContextTokens(messages) < estimateTokens(messages), 'usage anchor beats the raw estimate for a large prefix');
});

test('estimateContextTokens: an all-zero usage is ignored', () => {
  const messages: CompactableMessage[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'world', usage: { input: 0, output: 0 } },
  ];
  assert.equal(estimateContextTokens(messages), estimateTokens(messages));
});

test('estimateContextTokens: the last valid usage wins', () => {
  const messages: CompactableMessage[] = [
    { role: 'assistant', content: 'a', usage: { input: 100, output: 10 } },
    { role: 'assistant', content: 'b', usage: { input: 5000, output: 500 } },
    { role: 'tool', content: 'c'.repeat(4000), tool_call_id: 't1', name: 'bash' },
  ];
  const trailing = estimateTokens([messages[2]!]);
  assert.equal(estimateContextTokens(messages), 5500 + trailing);
});

test('estimateContextTokens: pi staleness guard ignores pre-compaction usage', () => {
  const mk = (anchorSeq: number | undefined): CompactableMessage[] => [
    { role: 'user', content: 'x'.repeat(4000) },
    { role: 'assistant', content: 'y', ...(anchorSeq !== undefined ? { seq: anchorSeq } : {}), usage: { input: 4000, output: 500 } },
    { role: 'user', content: 'z'.repeat(400) },
  ];
  const trailing = estimateTokens([{ role: 'user', content: 'z'.repeat(400) } as CompactableMessage]);
  // No boundary: the anchor is used.
  assert.equal(estimateContextTokens(mk(5)), 4500 + trailing);
  // Boundary at or past the anchor's seq: stale -> pure estimate.
  assert.equal(estimateContextTokens(mk(5), 5), estimateTokens(mk(5)));
  assert.equal(estimateContextTokens(mk(5), 9), estimateTokens(mk(5)));
  // Boundary before the anchor's seq: fresh -> used.
  assert.equal(estimateContextTokens(mk(5), 4), 4500 + trailing);
  // In-turn messages (no seq) are always fresh, even past the boundary.
  assert.equal(estimateContextTokens(mk(undefined), 9), 4500 + trailing);
});

test('estimateContextTokens: a stale anchor never shadows a newer in-turn usage', () => {
  const messages: CompactableMessage[] = [
    { role: 'assistant', content: 'a', seq: 3, usage: { input: 9000, output: 100 } },
    { role: 'user', content: 'b'.repeat(400) },
    { role: 'assistant', content: 'c', usage: { input: 200, output: 20 } }, // in-turn, no seq
  ];
  const trailing = 0; // the in-turn anchor is the last message
  // The walk finds the in-turn usage first; the stale one is never reached.
  assert.equal(estimateContextTokens(messages, 5), 220 + trailing);
  // Even when the in-turn usage is all-zero (skipped), the stale anchor is
  // not picked up: the estimate falls back to the pure one.
  const zero: CompactableMessage[] = [
    ...messages.slice(0, 2),
    { role: 'assistant', content: 'c', usage: { input: 0, output: 0 } },
  ];
  assert.equal(estimateContextTokens(zero, 5), estimateTokens(zero));
});

test('latestCompactionSeq: returns the last compaction record seq', () => {
  const rows: { role: string; seq: number }[] = [
    { role: 'user', seq: 1 },
    { role: 'compaction', seq: 2 },
    { role: 'assistant', seq: 3 },
    { role: 'compaction', seq: 7 },
  ];
  assert.equal(latestCompactionSeq(rows), 7);
  assert.equal(latestCompactionSeq(rows.slice(0, 1)), undefined);
});

test('toLlmMessages: persisted usage is read back onto the message', () => {
  const rows: HistoryRecord[] = [
    { seq: 1, role: 'user', content: 'a' },
    { seq: 2, role: 'assistant', content: 'b', meta: { usage: { input: 123, output: 45, totalTokens: 168 } } },
  ];
  const msgs = toLlmMessages(rows);
  assert.deepEqual(msgs[1]!.usage, { input: 123, output: 45, totalTokens: 168 });
  // A malformed usage (missing output) is dropped, not trusted.
  const bad: HistoryRecord[] = [
    { seq: 1, role: 'assistant', content: 'b', meta: { usage: { input: 123 } } },
  ];
  assert.equal(toLlmMessages(bad)[0]!.usage, undefined);
});
