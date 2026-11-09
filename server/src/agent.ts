import OpenAI from 'openai';
import { APIUserAbortError } from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { TOOLS, runTool, type ShellName } from './tools';
import { providerClient, type ProviderCreds } from './providers';
import { effortExtraParams } from './reasoning';
import { type Skill } from './skills';
import {
  compactionThreshold,
  compactMessages,
  estimateTokens,
  estimateContextTokens,
  summaryAsMessage,
  DEFAULT_CONTEXT_WINDOW,
  type CompactableMessage,
  type UsageInfo,
} from './compaction';

/** One OpenAI-style tool call (serialized form, safe for DB storage). */
export interface StoredToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: StoredToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning?: string; // assistant thinking, sent back for multi-turn continuity
  seq?: number; // history row seq when the message came from a persisted record
  fileLists?: { readFiles: string[]; modifiedFiles: string[] }; // summary message: carried file tracking
  usage?: UsageInfo; // assistant: provider-reported usage, the token-estimate anchor
}

export type AgentEvent =
  | { type: 'message.delta'; text: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'tool.round'; content: string; toolCalls: StoredToolCall[]; reasoning?: string; usage?: UsageInfo }
  | { type: 'tool.start'; id: string; name: string; args: unknown }
  | { type: 'tool.result'; id: string; name: string; result: string; ok?: boolean; diff?: string; shell?: ShellName }
  /**
   * Current context size for the UI, emitted before every LLM call
   * (so it updates as tool results accumulate, and right after compaction).
   * `window` is the model's context window, `threshold` the compaction trigger.
   */
  | { type: 'context'; tokens: number; window: number; threshold: number }
  /** Compaction has started: the old part of the context is being summarized. */
  | { type: 'compaction.start'; tokensBefore: number }
  /** The summarizer is still writing; `tokensOut` = estimated tokens of the summary so far. */
  | { type: 'compaction.progress'; tokensOut: number }
  /** Compaction finished: `summary` is what the checkpoint produced. */
  | {
      type: 'compaction';
      summary: string;
      firstKeptSeq: number | null;
      tokensBefore: number;
      tokensAfter: number;
      fileLists: { readFiles: string[]; modifiedFiles: string[] };
    }
  | { type: 'message.complete'; content: string; tokens: number; reasoning?: string; usage?: UsageInfo }
  /**
   * Emitted when the user stops the turn while the model was still
   * streaming a text reply. `content` holds the partial text so far, so
   * the route can persist it.
   */
  | { type: 'message.stopped'; content: string; tokens: number; reasoning?: string }
  | { type: 'error'; message: string };

/**
 * Loop guard, not a budget: a turn runs as many tool rounds as it needs
 * until the model replies with plain text. This only fires when the model
 * appears stuck in a tool loop (or a provider misbehaves); at that point
 * one final tool-less wrap-up call is made so the turn ends with a summary
 * instead of hanging forever. Context-length limits will be handled later
 * by conversation compaction, not by capping steps.
 */
const LOOP_GUARD = 200;

const SYSTEM_PROMPT = (workspace: string, skills: Skill[] = []) => {
  const base =
    `You are a local AI agent. Your working directory is ${workspace}. You can run shell commands and read/write files inside it (and its subdirectories) — that is the only place you may write. To modify an existing file use edit_file (targeted replacement) rather than rewriting the whole file with write_file; write_file is for new files. Use tools to actually do the work; never claim to have done something you did not. Be concise in your final answer.` +
    ' When the user writes @some/path in a message, it is a reference picked from the working directory: a file (or a directory, ending in "/") relative to it — read it before answering when it is relevant.';
  const usable = skills.filter((s) => !s.disableModelInvocation);
  if (usable.length === 0) return base;
  const list = usable
    .map((s) => `- ${s.name}: ${s.description} — instructions at ${s.filePath}`)
    .join('\n');
  return (
    base +
    `\n\nAvailable skills (specialized workflows for particular kinds of work). When the task matches one, first read its instructions with read_file, then follow them; bundled files are relative to the skill directory:
${list}`
  );
};

/** Extract displayable text from OpenRouter-style reasoning_details entries. */
function reasoningDetailsText(details: unknown): string {
  if (!Array.isArray(details)) return '';
  const parts: string[] = [];
  for (const d of details as { text?: unknown }[]) {
    if (d && typeof d.text === 'string' && d.text) parts.push(d.text);
  }
  return parts.join('\n');
}

export const DEFAULT_MODEL = () => process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

/**
 * Last-known context usage for a conversation: the estimated token size of
 * the full context (system prompt + messages) against the model's window and
 * compaction threshold. Same math as the live `context` stream event, so the
 * on-load value and the mid-turn value agree. */
export function contextUsage(
  messages: CompactableMessage[],
  workspace: string,
  contextWindow?: number,
  skills: Skill[] = [],
  staleUsageBeforeSeq?: number
): { tokens: number; window: number; threshold: number } {
  const conversation: CompactableMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT(workspace, skills) },
    ...messages,
  ];
  return {
    tokens: estimateContextTokens(conversation, staleUsageBeforeSeq),
    window: contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    threshold: compactionThreshold(contextWindow),
  };
}

/**
 * Run one full agent turn: LLM -> tool calls -> LLM -> ... until it replies
 * with plain text. Streams events as it goes. Only a pathological tool loop
 * ends the turn early, and even then via a tool-less wrap-up call (see
 * LOOP_GUARD) — there is no step budget.
 */
export async function* runAgentTurn(opts: {
  messages: CompactableMessage[];
  workspace: string;
  model?: string; // '' or undefined -> server default
  provider: ProviderCreds;
  /** The model's context window in tokens (provider config); unknown -> env/default. */
  contextWindow?: number;
  /** How hard the model should reason ('' = provider default). */
  reasoningEffort?: string;
  signal?: AbortSignal;
  /** Skills visible to this workspace (advertised in the system prompt,
   *  readable from the sandbox). */
  skills?: Skill[];
  /** Pi's staleness guard: the latest compaction record's seq (if the
   *  session has one). Usage anchors persisted at or before it reflect the
   *  pre-compaction context and are ignored by the token estimates. */
  staleUsageBeforeSeq?: number;
}): AsyncGenerator<AgentEvent> {
  const conversation: CompactableMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT(opts.workspace, opts.skills ?? []) },
    ...opts.messages,
  ];
  const model = opts.model?.trim() || DEFAULT_MODEL();
  const client = providerClient(opts.provider);
  const window = opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const threshold = compactionThreshold(opts.contextWindow);
  // Provider-specific body params for the session's reasoning effort
  // ({} when auto or when the provider/model doesn't accept them).
  const effortParams = effortExtraParams(
    opts.provider.baseUrl,
    model,
    opts.reasoningEffort ?? ''
  );
  // Pi's staleness guard, tracked across in-place compactions: after one,
  // every seq'd message in the conversation predates the new compaction
  // record, so the boundary moves past all of them (in-turn messages have
  // no seq and stay fresh).
  let staleBeforeSeq = opts.staleUsageBeforeSeq;

  /** True when the user requested a stop (the signal fired, or the SDK
   *  surfaced the abort as its APIUserAbortError). */
  const isAbort = (err: unknown) => opts.signal?.aborted === true || err instanceof APIUserAbortError;

  /** Tool result stubbed for calls skipped because the turn was stopped:
   *  history must stay valid, i.e. every assistant tool_call gets a
   *  matching tool result. */
  const STOPPED_NOTE = '(stopped by user before this ran)';

  /** True when the last compactInPlace call actually compacted (used by the
   *  overflow-recovery path to decide whether to retry the step). */
  let compactSucceeded = false;

  /**
   * Summarize the old part of the conversation in place, streaming
   * start/progress/compaction events as it happens. On failure nothing is
   * yielded (besides the start) and the turn continues with the full
   * context rather than aborting.
   */
  const compactInPlace = async function* (label: string): AsyncGenerator<AgentEvent> {
    compactSucceeded = false;
    const body = conversation.slice(1);
    try {
      yield { type: 'compaction.start', tokensBefore: estimateContextTokens(body) };
      const it = compactMessages({ messages: body, provider: opts.provider, model, signal: opts.signal });
      let lastEmit = 0;
      let step = await it.next();
      while (!step.done) {
        const now = Date.now();
        if (now - lastEmit >= 250) {
          yield { type: 'compaction.progress', tokensOut: Math.ceil(step.value.length / 4) };
          lastEmit = now;
        }
        step = await it.next();
      }
      const c = step.value;
      conversation.length = 1;
      conversation.push({ ...summaryAsMessage(c.summary), fileLists: c.fileLists }, ...body.slice(c.firstKeptIndex));
      compactSucceeded = true;
      staleBeforeSeq = Number.POSITIVE_INFINITY;
      yield {
        type: 'compaction',
        summary: c.summary,
        firstKeptSeq: c.firstKeptSeq,
        tokensBefore: c.tokensBefore,
        tokensAfter: estimateContextTokens(conversation, staleBeforeSeq),
        fileLists: c.fileLists,
      };
    } catch (err) {
      if (!isAbort(err)) console.warn(`[webui-h] ${label} compaction failed: ${String(err)}`);
    }
  };

  let step = 0;
  let overflowRetried = false;
  while (true) {
    // Stopped between steps (e.g. during a tool round or compaction).
    if (opts.signal?.aborted) return;
    const atGuard = step >= LOOP_GUARD;
    if (atGuard) {
      conversation.push({
        role: 'user',
        content:
          'You are still calling tools after many steps — the task may be stuck. '
          + 'Stop calling tools now and give a final answer: '
          + 'what you completed, what remains, and how to verify the work.',
      });
    }

    // Mid-turn compaction: tool results are the usual context growth; check
    // after each tool round, before the next LLM call.
    if (!atGuard && step > 0 && estimateContextTokens(conversation.slice(1), staleBeforeSeq) > threshold) {
      yield* compactInPlace('mid-turn');
    }
    // Report the current context size to the UI (also right after compaction).
    yield { type: 'context', tokens: estimateContextTokens(conversation, staleBeforeSeq), window, threshold };

    let content = '';
    let reasoning = '';
    let usage: UsageInfo | undefined;
    const rawCalls: { index: number; id?: string; name?: string; args: string }[] = [];

    // If the turn was stopped while the model was streaming, persist what
    // we have so far and end the turn without an error.
    function* stopEvents(): Generator<AgentEvent> {
      if (content) {
        conversation.push({
          role: 'assistant',
          content,
          ...(reasoning ? { reasoning } : {}),
        });
        yield {
          type: 'message.stopped',
          content,
          tokens: estimateContextTokens(conversation, staleBeforeSeq),
          ...(reasoning ? { reasoning } : {}),
        };
      }
    }

    let stream;
    try {
      stream = await client.chat.completions.create(
        {
          model,
          messages: conversation as unknown as ChatCompletionMessageParam[],
          ...(atGuard ? {} : { tools: TOOLS }),
          stream: true,
          stream_options: { include_usage: true },
          ...effortParams,
        },
        { signal: opts.signal }
      );
    } catch (err) {
      if (isAbort(err)) {
        yield* stopEvents();
        return;
      }
      // One-shot overflow recovery: the real context window is smaller than
      // estimated — compact aggressively and retry the same step.
      if (!overflowRetried && !atGuard && /context|token|too large|too long|exceed|overflow/i.test(String(err))) {
        overflowRetried = true;
        yield* compactInPlace('overflow-recovery');
        if (compactSucceeded) continue; // retry without consuming a step
      }
      throw err;
    }

    try {
      for await (const chunk of stream) {
        // Usage arrives on the final chunk (stream_options.include_usage).
        if (chunk.usage) {
          usage = {
            input: chunk.usage.prompt_tokens ?? 0,
            output: chunk.usage.completion_tokens ?? 0,
            cacheRead: chunk.usage.prompt_tokens_details?.cached_tokens,
            totalTokens: chunk.usage.total_tokens,
          };
        }
        const choice = chunk.choices[0] as
          | { delta?: unknown; message?: { reasoning?: unknown; reasoning_details?: unknown } }
          | undefined;
        const delta = choice?.delta as
          | { content?: string | null; tool_calls?: unknown[]; reasoning?: unknown }
          | undefined;
        if (typeof delta?.reasoning === 'string' && delta.reasoning) {
          reasoning += delta.reasoning;
          yield { type: 'thinking.delta', text: delta.reasoning };
        }
        if (delta?.content) {
          content += delta.content;
          yield { type: 'message.delta', text: delta.content };
        }
        for (const tc of (delta?.tool_calls ?? []) as {
          index: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }[]) {
          const slot = rawCalls[tc.index] ?? (rawCalls[tc.index] = { index: tc.index, args: '' });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
        // Final chunk: some providers deliver the (encrypted or plain) reasoning there.
        const finMsg = choice?.message;
        if (finMsg && !reasoning) {
          if (typeof finMsg.reasoning === 'string' && finMsg.reasoning) {
            reasoning = finMsg.reasoning;
          } else {
            reasoning = reasoningDetailsText(finMsg.reasoning_details);
          }
        }
      }
    } catch (err) {
      if (isAbort(err)) {
        yield* stopEvents();
        return;
      }
      throw err;
    }

    // The OpenAI SDK ends the stream cleanly when the request is aborted
    // (it swallows the AbortError by design), so a stop mid-stream shows
    // up as an abruptly finished stream rather than a throw.
    if (opts.signal?.aborted) {
      yield* stopEvents();
      return;
    }

    const calls = rawCalls.filter((c) => c.id && c.name);
    if (calls.length > 0) {
      if (atGuard) {
        // Tools were not offered on the wrap-up call — a provider that still
        // emits calls here is misbehaving; fail instead of looping.
        yield { type: 'error', message: 'agent appears stuck in a tool loop — stopped by the loop guard' };
        return;
      }
      const stored: StoredToolCall[] = calls.map((c) => ({
        id: c.id!,
        type: 'function',
        function: { name: c.name!, arguments: c.args },
      }));
      conversation.push({
        role: 'assistant',
        content: content || null,
        tool_calls: stored,
        ...(reasoning ? { reasoning } : {}),
        ...(usage ? { usage } : {}),
      });
      yield { type: 'tool.round', content, toolCalls: stored, ...(reasoning ? { reasoning } : {}), ...(usage ? { usage } : {}) };

      for (let i = 0; i < stored.length; i++) {
        // Stopped mid-batch: stub every remaining call so the persisted
        // history stays valid (each tool_call has a tool result).
        if (opts.signal?.aborted) {
          for (let j = i; j < stored.length; j++) {
            const c = stored[j]!;
            yield { type: 'tool.result', id: c.id, name: c.function.name, result: STOPPED_NOTE };
            conversation.push({
              role: 'tool',
              tool_call_id: c.id,
              content: STOPPED_NOTE,
              name: c.function.name,
            });
          }
          break;
        }
        const call = stored[i]!;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          args = { _invalid_json: call.function.arguments };
        }
        yield { type: 'tool.start', id: call.id, name: call.function.name, args };
        const result = await runTool(
          call.function.name,
          args,
          opts.workspace,
          opts.signal,
          (opts.skills ?? []).map((s) => s.dir)
        );
        yield {
          type: 'tool.result',
          id: call.id,
          name: call.function.name,
          result: result.output,
          ...(result.ok === false ? { ok: false } : {}),
          ...(result.diff ? { diff: result.diff } : {}),
          ...(result.shell ? { shell: result.shell } : {}),
        };
        conversation.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result.output,
          name: call.function.name,
        });
      }
      if (opts.signal?.aborted) return; // stopped mid-batch — end the turn
      step++;
      continue;
    }

    conversation.push({
      role: 'assistant',
      content: content || null,
      ...(reasoning ? { reasoning } : {}),
      ...(usage ? { usage } : {}),
    });
    yield {
      type: 'message.complete',
      content,
      tokens: estimateContextTokens(conversation, staleBeforeSeq),
      ...(reasoning ? { reasoning } : {}),
      ...(usage ? { usage } : {}),
    };
    return;
  }
}
