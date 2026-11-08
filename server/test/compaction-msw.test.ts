import test from 'node:test';
import assert from 'node:assert/strict';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  compactMessages,
  estimateTokens,
  findCutPoint,
  summaryAsMessage,
  type CompactableMessage,
  type CompactResult,
} from '../src/compaction';

/**
 * Compaction behavior tests with msw mocking the provider's
 * /v1/chat/completions endpoint (SSE). Covers the summarizer request
 * shape, live progress yields, file-list carry-over, iterative
 * compaction, span truncation, and failure paths.
 *
 * Note on sizes: with the default KEEP_RECENT_TOKENS (20000) each ~20k-char
 * message is ~5k tokens, so a cut point > 0 needs ~5-6 of them, with the
 * messages of interest (tool calls, previous summary) placed ahead of the
 * kept tail.
 */

const BASE = 'http://mock-provider/v1';
const creds = { baseUrl: BASE, apiKey: 'test-key' };

/** ~20k-char user message ≈ 5k tokens by the chars/4 estimate. */
const big = (tag: string): CompactableMessage => ({ role: 'user', content: `${tag} ${'x'.repeat(19_900)}` });

const toolMsg = (
  name: string,
  args: object,
  id = 'c1'
): CompactableMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

function sseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new HttpResponse(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

function sseText(text: string, finishReason: 'stop' | 'length' = 'stop'): unknown[] {
  const out: unknown[] = [
    { id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
  ];
  for (const piece of text.match(/.{1,32}/gs) ?? [])
    out.push({ id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece } }] });
  out.push({ id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
  return out;
}

const captured: Record<string, unknown>[] = [];
let mockChunks: unknown[] = sseText('## Goal\ndefault');

let flakyNext = false;
const server = setupServer(
  http.post(`${BASE}/chat/completions`, ({ request }) =>
    request.json().then((b) => {
      captured.push(b as Record<string, unknown>);
      if (flakyNext) {
        flakyNext = false;
        // A stream that dies mid-flight: the client sees a dropped connection.
        const encoder = new TextEncoder();
        const chunk = { id: 'm1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '## Goal\npar' } }] };
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            controller.error(new Error('socket closed'));
          },
        });
        return new HttpResponse(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return sseResponse(mockChunks);
    })
  )
);

test.before(() => server.listen({ onUnhandledFrame: 'error' }));
test.after(() => server.close());

/** Drive the generator to completion: live yields + the final result. */
async function runCompact(
  opts: Parameters<typeof compactMessages>[0]
): Promise<{ yields: string[]; result: CompactResult }> {
  const gen = compactMessages(opts);
  const yields: string[] = [];
  while (true) {
    const r = await gen.next();
    if (r.done) return { yields, result: r.value as CompactResult };
    yields.push(r.value as string);
  }
}

function promptOf(): string {
  const msgs = captured[0]!.messages as { content: string }[];
  return msgs[1]!.content;
}

test('compactMessages: happy path — live progress, result fields, file lists', async () => {
  captured.length = 0;
  mockChunks = sseText('## Goal\nsummarize the test\n\n## Progress\n### Done\n- [x] one\n- [x] two\n\n## Next Steps\n1. three');
  const messages: CompactableMessage[] = [
    toolMsg('read_file', { path: 'a.ts' }, 'c1'),
    toolMsg('edit_file', { path: 'b.ts' }, 'c2'),
    big('one'),
    big('two'),
    big('three'),
    big('four'),
    big('five'),
    big('six'),
    big('seven'),
  ];
  const { yields, result } = await runCompact({ messages, provider: creds, model: 'mock-model' });

  // Live progress: multiple yields, monotonically growing, ending at the summary.
  assert.ok(yields.length >= 2, `expected multiple progress yields, got ${yields.length}`);
  for (let i = 1; i < yields.length; i++)
    assert.ok(yields[i]!.length > yields[i - 1]!.length, 'yields must grow');
  assert.ok(yields[yields.length - 1]!.startsWith('## Goal'));

  // Result fields.
  assert.ok(result.summary.startsWith('## Goal\nsummarize the test'));
  const cut = findCutPoint(messages);
  assert.equal(result.firstKeptIndex, cut);
  assert.ok(cut > 0 && cut < messages.length);
  assert.equal(result.tokensBefore, estimateTokens(messages));
  // All messages are mid-turn (no seq) -> boundary = max persisted seq = 0.
  assert.equal(result.firstKeptSeq, 0);

  // File lists extracted from the span's tool calls (pi semantics, sorted).
  assert.ok(result.summary.includes('<read-files>\na.ts\n</read-files>'));
  assert.ok(result.summary.includes('<modified-files>\nb.ts\n</modified-files>'));
  assert.deepEqual(result.fileLists, { readFiles: ['a.ts'], modifiedFiles: ['b.ts'] });

  // Request shape: system prompt + conversation in <conversation> tags.
  assert.equal(captured.length, 1);
  const b = captured[0]!;
  assert.equal(b.model, 'mock-model');
  assert.equal(b.stream, true);
  const msgs = b.messages as { role: string; content: string }[];
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]!.role, 'system');
  assert.ok(msgs[0]!.content.includes('context summarization assistant'));
  assert.ok(msgs[0]!.content.includes('Do NOT continue the conversation'));
  assert.ok(promptOf().includes('<conversation>'));
  assert.ok(promptOf().includes('</conversation>'));
  assert.ok(promptOf().includes('[Assistant tool calls]: read_file('));
  assert.ok(promptOf().includes('edit_file('));
  assert.ok(!promptOf().includes('summarize the test'), 'the summary output must not be in the prompt');
  assert.ok(!promptOf().includes('<previous-summary>'), 'no previous summary on a first compaction');
});

test('compactMessages: nothing to summarize throws before any provider call', async () => {
  captured.length = 0;
  const messages = [
    { role: 'user' as const, content: 'hi' },
    { role: 'assistant' as const, content: 'hello' },
  ];
  await assert.rejects(
    (async () => {
      for await (const _ of compactMessages({ messages, provider: creds, model: 'mock-model' })) void _;
    })(),
    /nothing to summarize/
  );
  assert.equal(captured.length, 0, 'no provider call when there is nothing to summarize');
});

test('compactMessages: empty model output throws', async () => {
  captured.length = 0;
  mockChunks = sseText('   \n  '); // whitespace only
  const messages = [big('one'), big('two'), big('three'), big('four'), big('five'), big('six'), big('seven')];
  await assert.rejects(
    (async () => {
      for await (const _ of compactMessages({ messages, provider: creds, model: 'mock-model' })) void _;
    })(),
    /empty summary/
  );
});

test('compactMessages: iterative — previous summary is merged and file lists carried', async () => {
  captured.length = 0;
  mockChunks = sseText('## Goal\nmerged');
  const messages = [
    summaryAsMessage(
      '## Goal\nold goal\n\n<read-files>\nprev.ts\n</read-files>\n\n<modified-files>\nold-mod.ts\n</modified-files>'
    ),
    toolMsg('read_file', { path: 'new.ts' }, 'c1'),
    big('one'),
    big('two'),
    big('three'),
    big('four'),
    big('five'),
    big('six'),
    big('seven'),
  ];
  const { result } = await runCompact({ messages, provider: creds, model: 'mock-model' });

  // The prompt uses the update variant with the previous summary in tags.
  const prompt = promptOf();
  assert.ok(prompt.includes('<previous-summary>'));
  assert.ok(prompt.includes('old goal'));
  assert.ok(prompt.includes('PRESERVE all existing information'));
  assert.ok(prompt.includes('<read-files>\nprev.ts'), 'previous file lists are in the prompt for merging');
  // The summary message itself is not serialized as a [User] line.
  assert.ok(!prompt.includes('[User]: CONTEXT SUMMARY'));

  // File lists accumulate: previous + this span's tool calls.
  const read = result.summary.match(/<read-files>\n([\s\S]*?)\n<\/read-files>/)![1]!.split('\n');
  assert.ok(read.includes('prev.ts') && read.includes('new.ts'), read.join(','));
  const modified = result.summary.match(/<modified-files>\n([\s\S]*?)\n<\/modified-files>/)![1]!.split('\n');
  assert.deepEqual(modified, ['old-mod.ts']);
  assert.deepEqual(result.fileLists, { readFiles: ['new.ts', 'prev.ts'], modifiedFiles: ['old-mod.ts'] });
});

test('compactMessages: a read-then-written file lands in modified only', async () => {
  captured.length = 0;
  mockChunks = sseText('## Goal\nthree sets');
  const messages = [
    toolMsg('read_file', { path: 'both.ts' }, 'c1'),
    toolMsg('write_file', { path: 'both.ts' }, 'c2'),
    toolMsg('read_file', { path: 'only-read.ts' }, 'c3'),
    big('one'),
    big('two'),
    big('three'),
    big('four'),
    big('five'),
    big('six'),
    big('seven'),
  ];
  const { result } = await runCompact({ messages, provider: creds, model: 'mock-model' });
  // both.ts was read and written -> modified only; only-read.ts -> read only.
  assert.deepEqual(result.fileLists, { readFiles: ['only-read.ts'], modifiedFiles: ['both.ts'] });
  assert.ok(!result.summary.includes('both.ts\n</read-files>'), 'written file must not be in read-files');
});

test('compactMessages: file lists carry over from structured meta (no text blocks)', async () => {
  captured.length = 0;
  mockChunks = sseText('## Goal\nmeta carry');
  const messages = [
    // Previous summary without text blocks: lists live on the message meta only.
    { ...summaryAsMessage('## Goal\nold goal'), fileLists: { readFiles: ['meta-read.ts'], modifiedFiles: ['meta-mod.ts'] } },
    toolMsg('read_file', { path: 'new.ts' }, 'c1'),
    big('one'),
    big('two'),
    big('three'),
    big('four'),
    big('five'),
    big('six'),
    big('seven'),
  ];
  const { result } = await runCompact({ messages, provider: creds, model: 'mock-model' });
  assert.deepEqual(result.fileLists, { readFiles: ['meta-read.ts', 'new.ts'], modifiedFiles: ['meta-mod.ts'] });
});

test('compactMessages: oversized span is truncated (oldest dropped, tail kept)', async () => {
  captured.length = 0;
  mockChunks = sseText('## Goal\ntrunc');
  const huge = { role: 'user' as const, content: 'H'.repeat(500_000) };
  const messages = [huge, big('one'), big('two'), big('three'), big('four'), big('five')];
  await runCompact({ messages, provider: creds, model: 'mock-model' });

  const prompt = promptOf();
  assert.ok(prompt.includes('chars of this span were too large to include'));
  assert.ok(prompt.includes('H'.repeat(1000)), 'tail of the huge message is kept');
  assert.ok(!prompt.startsWith('H'.repeat(1000)), 'oldest part is dropped');
});

test('compactMessages: a length stop rejects the truncated summary', async () => {
  captured.length = 0;
  mockChunks = sseText('## Goal\ntruncated', 'length');
  const messages = [big('one'), big('two'), big('three'), big('four'), big('five'), big('six'), big('seven')];
  await assert.rejects(
    (async () => {
      for await (const _ of compactMessages({ messages, provider: creds, model: 'mock-model' })) void _;
    })(),
    /token cap and the summary is incomplete/
  );
});

test('compactMessages: a transient stream drop is retried once', async () => {
  captured.length = 0;
  flakyNext = true;
  mockChunks = sseText('## Goal\nrecovered');
  const messages = [big('one'), big('two'), big('three'), big('four'), big('five'), big('six'), big('seven')];
  const { result } = await runCompact({ messages, provider: creds, model: 'mock-model' });
  assert.ok(result.summary.startsWith('## Goal\nrecovered'));
  assert.equal(captured.length, 2, 'one retry after the drop');
});

test('compactMessages: reasoning effort is passed through for generic providers', async () => {
  captured.length = 0;
  mockChunks = sseText('## Goal\neffort');
  const messages = [big('one'), big('two'), big('three'), big('four'), big('five'), big('six'), big('seven')];
  await runCompact({ messages, provider: creds, model: 'mock-model', reasoningEffort: 'high' });
  assert.equal(captured[0]!.reasoning_effort, 'high');
});

test('compactMessages: aborted signal fails the call', async () => {
  captured.length = 0;
  const messages = [big('one'), big('two'), big('three'), big('four'), big('five'), big('six'), big('seven')];
  const ac = new AbortController();
  ac.abort();
  const signal = ac.signal;
  await assert.rejects(
    (async () => {
      for await (const _ of compactMessages({ messages, provider: creds, model: 'mock-model', signal })) void _;
    })(),
    Error
  );
});
