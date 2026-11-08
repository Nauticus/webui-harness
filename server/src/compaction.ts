import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { LlmMessage, StoredToolCall } from './agent';
import type { HistoryRecord } from './history';
import { providerClient, type ProviderCreds } from './providers';
import { effortExtraParams } from './reasoning';

/**
 * Context compaction, modeled on the pi coding agent's approach:
 *
 * - Trigger: estimated context tokens exceed the model's context window
 *   (provider config, else env/default) minus RESERVE_TOKENS.
 * - Cut point: walk backwards from the end keeping ~KEEP_RECENT_TOKENS verbatim,
 *   never orphaning a tool result from its assistant tool_calls.
 * - The old span is serialized to flat text (tool results truncated) so the
 *   model summarizes instead of continuing the conversation.
 * - The LLM produces a structured handoff summary (Goal / Progress / ...),
 *   merged iteratively with any previous summary; read/modified file lists are
 *   extracted from tool calls and carried across compactions.
 * - The result is a persistent Compaction record (see history.ts role
 *   'compaction'): next requests are system + summary + records with
 *   seq > firstKeptSeq.
 */

// Settings (env-overridable). The context window is per-model: when the
// provider config knows the model's window it wins; otherwise the env
// value / default below is used.
export const DEFAULT_CONTEXT_WINDOW = Number(process.env.COMPACT_CONTEXT_WINDOW ?? 128_000);
export const RESERVE_TOKENS = Number(process.env.COMPACT_RESERVE_TOKENS ?? 16_384);
export const KEEP_RECENT_TOKENS = Number(process.env.COMPACT_KEEP_RECENT_TOKENS ?? 20_000);

/** Compaction starts when the estimated context exceeds this many tokens. */
export function compactionThreshold(contextWindow?: number): number {
  const window = contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
  return Math.max(0, window - RESERVE_TOKENS);
}

const TOOL_RESULT_SERIALIZED_LIMIT = 2000;
const TOOL_ARGS_SERIALIZED_LIMIT = 400;
/** Hard cap on the serialized span sent to the summarizer (oldest part dropped). */
const MAX_SERIALIZED_CHARS = 400_000;

/** Transient stream-drop signatures: the summarizer call is retried once for these. */
const TRANSIENT_STREAM_RE = /terminated|socket|econnreset|etimedout|econnrefused|fetch failed|network/i;

/** LlmMessage plus its history seq when it came from a persisted record. */
export interface CompactableMessage extends LlmMessage {
  seq?: number;
}

const SUMMARY_PREFIX =
  'CONTEXT SUMMARY (earlier conversation, summarized to free context). ' +
  'Treat it as the reliable record of what happened so far:\n\n';

/** Wrap a stored summary as the user message that re-injects it. */
export function summaryAsMessage(summary: string): CompactableMessage {
  return { role: 'user', content: SUMMARY_PREFIX + summary };
}

function isSummaryMessage(m: CompactableMessage): boolean {
  return m.role === 'user' && (m.content ?? '').startsWith(SUMMARY_PREFIX);
}

function summaryText(m: CompactableMessage): string {
  return (m.content ?? '').slice(SUMMARY_PREFIX.length);
}

/**
 * Rough token estimate (chars/4 + per-message overhead). No tokenizer on
 * purpose: it only needs to be good enough for threshold decisions.
 */
export function estimateTokens(
  messages: Pick<CompactableMessage, 'content' | 'tool_calls'>[]
): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) chars += tc.function.name.length + tc.function.arguments.length + 24;
    }
    chars += 8;
  }
  return Math.ceil(chars / 4);
}

/**
 * Index of the first message to keep verbatim: accumulate from the end until
 * KEEP_RECENT_TOKENS is reached. The kept span never starts with a tool
 * result (it must stay with its tool_calls), so back up over tool messages.
 */
export function findCutPoint(messages: CompactableMessage[]): number {
  let acc = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    cut = i;
    acc += estimateTokens([messages[i]!]);
    if (acc >= KEEP_RECENT_TOKENS) break;
  }
  while (cut > 0 && messages[cut]!.role === 'tool') cut--;
  return cut;
}

/** Serialize a span to flat text the summarizer will not mistake for a live chat. */
export function serializeSpan(messages: CompactableMessage[]): string {
  const out: string[] = [];
  for (const m of messages) {
    if (isSummaryMessage(m)) {
      out.push(`[Previous summary]:\n${summaryText(m)}`);
    } else if (m.role === 'user') {
      out.push(`[User]: ${m.content ?? ''}`);
    } else if (m.role === 'assistant') {
      if (m.content) out.push(`[Assistant]: ${m.content}`);
      if (m.tool_calls && m.tool_calls.length > 0) {
        out.push(
          `[Assistant tool calls]: ${m.tool_calls
            .map((tc) => `${tc.function.name}(${tc.function.arguments.slice(0, TOOL_ARGS_SERIALIZED_LIMIT)})`)
            .join('; ')}`
        );
      }
    } else if (m.role === 'tool') {
      const c = m.content ?? '';
      const cut =
        c.length > TOOL_RESULT_SERIALIZED_LIMIT
          ? `${c.slice(0, TOOL_RESULT_SERIALIZED_LIMIT)}\n[...${c.length - TOOL_RESULT_SERIALIZED_LIMIT} chars truncated]`
          : c;
      out.push(`[Tool ${m.name ?? 'result'}]: ${cut}`);
    }
  }
  return out.join('\n\n');
}

interface FileOps {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

/** Computed file lists carried on the summary message and the persisted record. */
export interface FileLists {
  readFiles: string[];
  modifiedFiles: string[];
}

function parseFileList(summary: string | undefined, tag: string): string[] {
  if (!summary) return [];
  const m = summary.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  return m ? (m[1] ?? '').split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

function addFileOp(toolName: string, args: Record<string, unknown>, ops: FileOps): void {
  const path = typeof args.path === 'string' ? args.path : undefined;
  if (!path) return;
  switch (toolName) {
    case 'read_file':
      ops.read.add(path);
      break;
    case 'write_file':
      ops.written.add(path);
      break;
    case 'edit_file':
      ops.edited.add(path);
      break;
  }
}

/** Cumulative file tracking: previous summary's lists + this span's tool calls. */
function collectFileOps(messages: CompactableMessage[], prev: FileLists): FileOps {
  const ops: FileOps = { read: new Set(), written: new Set(), edited: new Set() };
  for (const f of prev.readFiles) ops.read.add(f);
  for (const f of prev.modifiedFiles) ops.edited.add(f);
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        continue;
      }
      addFileOp(tc.function.name, args, ops);
    }
  }
  return ops;
}

/**
 * Compute final file lists from file operations (pi semantics): readFiles are
 * files only read, not modified; modifiedFiles = written ∪ edited. Sorted.
 */
function computeFileLists(ops: FileOps): FileLists {
  const modified = new Set([...ops.edited, ...ops.written]);
  const readFiles = [...ops.read].filter((f) => !modified.has(f)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles, modifiedFiles };
}

function formatFileOperations({ readFiles, modifiedFiles }: FileLists): string {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join('\n')}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join('\n')}\n</modified-files>`);
  return sections.length > 0 ? `\n\n${sections.join('\n\n')}` : '';
}

const SUMMARY_SYSTEM_PROMPT =
  'You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\n' +
  'Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.';

const SUMMARY_FORMAT =
  `## Goal\n[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]\n\n` +
  `## Constraints & Preferences\n- [Any constraints, preferences, or requirements mentioned by user]\n- [Or "(none)" if none were mentioned]\n\n` +
  `## Progress\n### Done\n- [x] [Completed tasks/changes]\n\n### In Progress\n- [ ] [Current work]\n\n### Blocked\n- [Issues preventing progress, if any]\n\n` +
  `## Key Decisions\n- **[Decision]: [Brief rationale]\n\n` +
  `## Next Steps\n1. [Ordered list of what should happen next]\n\n` +
  `## Critical Context\n- [Any data, examples, or references needed to continue]\n- [Or "(none)" if not applicable]\n\n` +
  'Keep each section concise. Preserve exact file paths, function names, and error messages.';

const SUMMARIZATION_PROMPT =
  'The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.\n\n' +
  'Use this EXACT format:\n\n' + SUMMARY_FORMAT;

const UPDATE_SUMMARIZATION_INSTRUCTIONS =
  'Update the existing structured summary with new information. RULES:\n' +
  '- PRESERVE all existing information from the previous summary\n' +
  '- ADD new progress, decisions, and context from the new messages\n' +
  '- UPDATE the Progress section: move items from "In Progress" to "Done" when completed\n' +
  '- UPDATE "Next Steps" based on what was accomplished\n' +
  '- PRESERVE exact file paths, function names, and error messages\n' +
  '- If something is no longer relevant, you may remove it\n\n' +
  'Use this EXACT format:\n\n' + SUMMARY_FORMAT;

const UPDATE_SUMMARIZATION_PROMPT =
  'The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.\n\n' +
  UPDATE_SUMMARIZATION_INSTRUCTIONS;

/**
 * The summarizer prompt: the conversation in <conversation> tags, the previous
 * summary in <previous-summary> tags (when present), then the format prompt —
 * the update variant when a previous summary exists.
 */
function buildSummaryPrompt(previousSummary: string | undefined, serialized: string): string {
  let prompt = `<conversation>\n${serialized}\n</conversation>\n\n`;
  if (previousSummary) prompt += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  return prompt + (previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT);
}

export interface CompactResult {
  summary: string;
  /** Index in the input `messages` array where the kept span starts. */
  firstKeptIndex: number;
  /** Persisted records with seq > firstKeptSeq are kept verbatim (null = keep all). */
  firstKeptSeq: number | null;
  tokensBefore: number;
  /** Computed file lists (pi semantics), persisted on the record's meta. */
  fileLists: FileLists;
}

/**
 * Kept-boundary rule for persistence: if the first kept message has a seq,
 * keep records with seq >= that one; if it was created mid-turn (no seq),
 * every persisted record was summarized, so keep only records appended
 * after the turn (seq > max persisted seq).
 */
export function firstKeptSeqOf(messages: CompactableMessage[], rest: CompactableMessage[]): number | null {
  const firstKept = rest[0]!;
  return firstKept.seq !== undefined ? firstKept.seq - 1 : Math.max(0, ...messages.map((m) => m.seq ?? 0));
}

/**
 * Build the LLM message list from persisted history. The latest 'compaction'
 * record defines the effective context: its summary (as a user message) plus
 * all records with seq > firstKeptSeq; older records stay on disk but are not
 * sent to the model. Each message carries its history seq so mid-turn
 * compaction can compute a new kept boundary.
 */
export function toLlmMessages(rows: HistoryRecord[]): CompactableMessage[] {
  let summary: string | null = null;
  let firstKeptSeq: number | null = null;
  let fileLists: FileLists | null = null;
  for (const r of rows) {
    if (r.role === 'compaction') {
      summary = r.content;
      const meta = (r.meta ?? {}) as {
        firstKeptSeq?: unknown;
        fileLists?: { readFiles?: unknown; modifiedFiles?: unknown };
      };
      firstKeptSeq = typeof meta.firstKeptSeq === 'number' ? meta.firstKeptSeq : null;
      // Structured lists from the record's meta; fall back to the text
      // blocks for records persisted before the meta field existed.
      const rl = meta.fileLists?.readFiles;
      const ml = meta.fileLists?.modifiedFiles;
      fileLists =
        Array.isArray(rl) && Array.isArray(ml)
          ? { readFiles: rl.map(String), modifiedFiles: ml.map(String) }
          : { readFiles: parseFileList(r.content, 'read-files'), modifiedFiles: parseFileList(r.content, 'modified-files') };
    }
  }
  const out: CompactableMessage[] = [];
  if (summary) out.push({ ...summaryAsMessage(summary), ...(fileLists ? { fileLists } : {}) });
  for (const r of rows) {
    if (r.role === 'compaction') continue;
    if (summary && firstKeptSeq !== null && r.seq <= firstKeptSeq) continue;
    const meta = (r.meta ?? {}) as {
      tool_calls?: StoredToolCall[];
      tool_call_id?: unknown;
      name?: unknown;
      reasoning?: unknown;
    };
    out.push({
      role: r.role as LlmMessage['role'],
      content: r.content || null,
      seq: r.seq,
      ...(meta.tool_calls ? { tool_calls: meta.tool_calls } : {}),
      ...(meta.tool_call_id !== undefined ? { tool_call_id: String(meta.tool_call_id) } : {}),
      ...(meta.name !== undefined ? { name: String(meta.name) } : {}),
      ...(r.role === 'assistant' && meta.reasoning ? { reasoning: String(meta.reasoning) } : {}),
    });
  }
  return out;
}

/**
 * Summarize the old part of `messages` (no system prompt) and return the new
 * summary plus where the kept span starts. The summarizer call is
 * streamed: as the summary is written, the accumulated text so far is
 * yielded (live progress for the UI). Throws when there is nothing
 * meaningful to summarize or the LLM returns nothing usable.
 */
export async function* compactMessages(opts: {
  messages: CompactableMessage[];
  provider: ProviderCreds;
  model: string;
  /** Same reasoning effort the session uses ('' = provider default). */
  reasoningEffort?: string;
  signal?: AbortSignal;
}): AsyncGenerator<string, CompactResult> {
  const { messages, provider, model, reasoningEffort, signal } = opts;
  const effortParams = effortExtraParams(provider.baseUrl, model, reasoningEffort ?? '');
  const tokensBefore = estimateTokens(messages);
  const cut = findCutPoint(messages);
  if (cut <= 0) throw new Error('compaction: nothing to summarize');
  const span = messages.slice(0, cut);
  const rest = messages.slice(cut);

  // Iterative compaction: pass the previous summary to the summarizer and
  // carry its file lists forward (structured meta, text-block fallback for
  // records persisted before the meta field existed).
  let previousSummary: string | undefined;
  const prevIdx = span.findIndex(isSummaryMessage);
  const spanToSerialize = prevIdx === -1 ? span : span.filter((_, i) => i !== prevIdx);
  let prevLists: FileLists = { readFiles: [], modifiedFiles: [] };
  if (prevIdx !== -1) {
    const prevMsg = span[prevIdx]!;
    previousSummary = summaryText(prevMsg);
    const metaLists = prevMsg.fileLists;
    prevLists =
      metaLists && Array.isArray(metaLists.readFiles) && Array.isArray(metaLists.modifiedFiles)
        ? metaLists
        : { readFiles: parseFileList(previousSummary, 'read-files'), modifiedFiles: parseFileList(previousSummary, 'modified-files') };
  }
  const ops = collectFileOps(spanToSerialize, prevLists);

  let serialized = serializeSpan(spanToSerialize);
  if (serialized.length > MAX_SERIALIZED_CHARS) {
    serialized = `[oldest ${serialized.length - MAX_SERIALIZED_CHARS} chars of this span were too large to include]\n\n` + serialized.slice(-MAX_SERIALIZED_CHARS);
  }

  const client = providerClient(provider);
  // One summarizer attempt: streams the partial summary, returns the trimmed
  // full text. A length stop means the summary is truncated — reject it.
  const runSummarizer = async function* (): AsyncGenerator<string, string> {
    const stream = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: buildSummaryPrompt(previousSummary, serialized) },
        ] as ChatCompletionMessageParam[],
        stream: true,
        ...effortParams,
      },
      { signal }
    );
    let text = '';
    let finishReason: string | undefined;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta?.content;
      if (delta) {
        text += delta;
        yield text; // live progress: the summary so far
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
    if (finishReason === 'length') {
      throw new Error('compaction: generation hit the token cap and the summary is incomplete');
    }
    return text.trim();
  };
  // Retried once on a transient stream drop (a dropped connection is not a
  // summary failure). Aborts and non-transient errors are never retried.
  const runWithRetry = async function* (): AsyncGenerator<string, string> {
    try {
      const it = runSummarizer();
      let step = await it.next();
      while (!step.done) {
        yield step.value;
        step = await it.next();
      }
      return step.value;
    } catch (err) {
      const transient = err instanceof Error && TRANSIENT_STREAM_RE.test(String(err.message));
      if (!transient || signal?.aborted) throw err;
      const it = runSummarizer();
      let step = await it.next();
      while (!step.done) {
        yield step.value;
        step = await it.next();
      }
      return step.value;
    }
  };
  const retryIt = runWithRetry();
  let step = await retryIt.next();
  while (!step.done) {
    yield step.value;
    step = await retryIt.next();
  }
  const summary = step.value;
  if (!summary) throw new Error('compaction: model returned an empty summary');

  const fileLists = computeFileLists(ops);
  return {
    summary: summary + formatFileOperations(fileLists),
    firstKeptIndex: cut,
    firstKeptSeq: firstKeptSeqOf(messages, rest),
    tokensBefore,
    fileLists,
  };
}
