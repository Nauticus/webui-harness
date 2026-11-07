import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  findCutPoint,
  serializeSpan,
  summaryAsMessage,
  firstKeptSeqOf,
  toLlmMessages,
  compactionThreshold,
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
  assert.equal(findCutPoint(msgs), 0);
});

test('findCutPoint: keeps the tail worth ~KEEP_RECENT_TOKENS', () => {
  const n = 20;
  const msgs = Array.from({ length: n }, (_, i) => user(`${i} ${'word '.repeat(2000)}`)); // ~5k tokens each
  const cut = findCutPoint(msgs);
  const keptTokens = estimateTokens(msgs.slice(cut));
  assert.ok(cut > 0 && cut < n, `cut=${cut}`);
  assert.ok(keptTokens >= KEEP_RECENT_TOKENS * 0.9, `kept=${keptTokens}`);
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
  const cut = findCutPoint(msgs);
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

test('serializeSpan: flat labels, truncated tool results, tool-call args', () => {
  const long = 'y'.repeat(10_000);
  const text = serializeSpan([
    user('do the thing'),
    asst('on it'),
    callMsg('c1', 'edit_file', { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }),
    toolMsg('c1', 'edit_file', long),
  ]);
  assert.ok(text.includes('[User]: do the thing'));
  assert.ok(text.includes('[Assistant]: on it'));
  assert.ok(text.includes('[Assistant tool calls]: edit_file('));
  assert.ok(text.includes('[Tool edit_file]: '));
  assert.ok(text.includes('8000 chars truncated'));
  assert.ok(!text.includes('y'.repeat(5000))); // truncated, not full content
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
