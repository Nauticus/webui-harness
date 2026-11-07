import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { LlmMessage, StoredToolCall } from './agent';
import type { HistoryRecord } from './history';
import { providerClient, type ProviderCreds } from './providers';

/**
 * Context compaction, modeled on the pi coding agent's approach:
 *
 * - Trigger: estimated context tokens exceed CONTEXT_WINDOW - RESERVE_TOKENS.
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

// Settings (env-overridable; the window is a guess per model until we detect it).
export const CONTEXT_WINDOW = Number(process.env.COMPACT_CONTEXT_WINDOW ?? 128_000);
export const RESERVE_TOKENS = Number(process.env.COMPACT_RESERVE_TOKENS ?? 16_384);
export const KEEP_RECENT_TOKENS = Number(process.env.COMPACT_KEEP_RECENT_TOKENS ?? 20_000);
/** Compaction starts when the estimated context exceeds this many tokens. */
export const COMPACT_THRESHOLD = Math.max(0, CONTEXT_WINDOW - RESERVE_TOKENS);

const TOOL_RESULT_SERIALIZED_LIMIT = 2000;
const TOOL_ARGS_SERIALIZED_LIMIT = 400;
/** Hard cap on the serialized span sent to the summarizer (oldest part dropped). */
const MAX_SERIALIZED_CHARS = 400_000;

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
  modified: Set<string>;
}

function parseFileList(summary: string | undefined, tag: string): string[] {
  if (!summary) return [];
  const m = summary.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  return m ? (m[1] ?? '').split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

/** Cumulative file tracking: previous summary's lists + this span's tool calls. */
function collectFileOps(messages: CompactableMessage[], prev: FileOps): FileOps {
  const ops: FileOps = { read: new Set(prev.read), modified: new Set(prev.modified) };
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        continue;
      }
      const p = typeof args.path === 'string' ? args.path : undefined;
      if (!p) continue;
      if (tc.function.name === 'read_file') ops.read.add(p);
      else if (tc.function.name === 'write_file' || tc.function.name === 'edit_file') ops.modified.add(p);
    }
  }
  return ops;
}

function appendFileLists(summary: string, ops: FileOps): string {
  const blocks: string[] = [];
  if (ops.read.size > 0) blocks.push(`<read-files>\n${[...ops.read].join('\n')}\n</read-files>`);
  if (ops.modified.size > 0) blocks.push(`<modified-files>\n${[...ops.modified].join('\n')}\n</modified-files>`);
  return blocks.length > 0 ? `${summary}\n\n${blocks.join('\n\n')}` : summary;
}

const SUMMARY_SYSTEM_PROMPT =
  'You are compressing a coding-agent conversation so the agent can continue with limited context. ' +
  'You are not continuing the conversation — you are writing a handoff for the agent that will. ' +
  'Be precise and factual; never claim work was done that the conversation does not show.';

function buildSummaryPrompt(previousSummary: string | undefined, serialized: string): string {
  return (
    (previousSummary
      ? `A previous summary exists. Merge its still-relevant content into the new summary (drop what is now stale):\n\n${previousSummary}\n\n`
      : '') +
    `Conversation to summarize:\n\n${serialized}\n\n` +
    `Write the new summary in exactly this markdown structure (omit a subsection only when it is empty):\n\n` +
    `## Goal\n[what the user is trying to accomplish]\n\n` +
    `## Constraints & Preferences\n- [requirements the user stated]\n\n` +
    `## Progress\n### Done\n- [x] [completed work]\n### In Progress\n- [ ] [current work]\n### Blocked\n- [issues, if any]\n\n` +
    `## Key Decisions\n- **[decision]**: [rationale]\n\n` +
    `## Next Steps\n1. [what should happen next]\n\n` +
    `## Critical Context\n- [facts needed to continue: file states, untested changes, versions]\n\n` +
    `Output only the summary markdown — no preamble, and no file lists (those are appended separately).`
  );
}

export interface CompactResult {
  summary: string;
  /** Index in the input `messages` array where the kept span starts. */
  firstKeptIndex: number;
  /** Persisted records with seq > firstKeptSeq are kept verbatim (null = keep all). */
  firstKeptSeq: number | null;
  tokensBefore: number;
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
  for (const r of rows) {
    if (r.role === 'compaction') {
      summary = r.content;
      const fks = (r.meta as { firstKeptSeq?: unknown } | undefined)?.firstKeptSeq;
      firstKeptSeq = typeof fks === 'number' ? fks : null;
    }
  }
  const out: CompactableMessage[] = [];
  if (summary) out.push(summaryAsMessage(summary));
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
 * summary plus where the kept span starts. Throws when there is nothing
 * meaningful to summarize or the LLM returns nothing usable.
 */
export async function compactMessages(opts: {
  messages: CompactableMessage[];
  provider: ProviderCreds;
  model: string;
  signal?: AbortSignal;
}): Promise<CompactResult> {
  const { messages, provider, model, signal } = opts;
  const tokensBefore = estimateTokens(messages);
  const cut = findCutPoint(messages);
  if (cut <= 0) throw new Error('compaction: nothing to summarize');
  const span = messages.slice(0, cut);
  const rest = messages.slice(cut);

  // Iterative compaction: pass the previous summary to the summarizer and
  // carry its file lists forward.
  let previousSummary: string | undefined;
  const prevIdx = span.findIndex(isSummaryMessage);
  const spanToSerialize = prevIdx === -1 ? span : span.filter((_, i) => i !== prevIdx);
  if (prevIdx !== -1) previousSummary = summaryText(span[prevIdx]!);

  const ops = collectFileOps(spanToSerialize, {
    read: new Set(parseFileList(previousSummary, 'read-files')),
    modified: new Set(parseFileList(previousSummary, 'modified-files')),
  });

  let serialized = serializeSpan(spanToSerialize);
  if (serialized.length > MAX_SERIALIZED_CHARS) {
    serialized = `[oldest ${serialized.length - MAX_SERIALIZED_CHARS} chars of this span were too large to include]\n\n` + serialized.slice(-MAX_SERIALIZED_CHARS);
  }

  const client = providerClient(provider);
  const res = await client.chat.completions.create(
    {
      model,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: buildSummaryPrompt(previousSummary, serialized) },
      ] as ChatCompletionMessageParam[],
    },
    { signal }
  );
  const summary = res.choices[0]?.message?.content?.trim() ?? '';
  if (!summary) throw new Error('compaction: model returned an empty summary');

  return {
    summary: appendFileLists(summary, ops),
    firstKeptIndex: cut,
    firstKeptSeq: firstKeptSeqOf(messages, rest),
    tokensBefore,
  };
}
