import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { TOOLS, runTool } from './tools';
import { providerClient, type ProviderCreds } from './providers';

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
}

export type AgentEvent =
  | { type: 'message.delta'; text: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'tool.round'; content: string; toolCalls: StoredToolCall[]; reasoning?: string }
  | { type: 'tool.start'; id: string; name: string; args: unknown }
  | { type: 'tool.result'; id: string; name: string; result: string; diff?: string }
  | { type: 'message.complete'; content: string; reasoning?: string }
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

const SYSTEM_PROMPT = (workspace: string) =>
  `You are a local AI agent. Your working directory is ${workspace}. You can run shell commands and read/write files inside it (and its subdirectories) — that is the only place you may write. To modify an existing file use edit_file (targeted replacement) rather than rewriting the whole file with write_file; write_file is for new files. Use tools to actually do the work; never claim to have done something you did not. Be concise in your final answer.`;

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
 * Run one full agent turn: LLM -> tool calls -> LLM -> ... until it replies
 * with plain text. Streams events as it goes. Only a pathological tool loop
 * ends the turn early, and even then via a tool-less wrap-up call (see
 * LOOP_GUARD) — there is no step budget.
 */
export async function* runAgentTurn(opts: {
  messages: LlmMessage[];
  workspace: string;
  model?: string; // '' or undefined -> server default
  provider: ProviderCreds;
  signal?: AbortSignal;
}): AsyncGenerator<AgentEvent> {
  const conversation: LlmMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT(opts.workspace) },
    ...opts.messages,
  ];
  const model = opts.model?.trim() || DEFAULT_MODEL();
  const client = providerClient(opts.provider);

  for (let step = 0; ; step++) {
    const atGuard = step === LOOP_GUARD;
    if (atGuard) {
      conversation.push({
        role: 'user',
        content:
          'You are still calling tools after many steps — the task may be stuck. '
          + 'Stop calling tools now and give a final answer: '
          + 'what you completed, what remains, and how to verify the work.',
      });
    }
    const stream = await client.chat.completions.create(
      {
        model,
        messages: conversation as unknown as ChatCompletionMessageParam[],
        ...(atGuard ? {} : { tools: TOOLS }),
        stream: true,
      },
      { signal: opts.signal }
    );

    let content = '';
    let reasoning = '';
    const rawCalls: { index: number; id?: string; name?: string; args: string }[] = [];

    for await (const chunk of stream) {
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
      });
      yield { type: 'tool.round', content, toolCalls: stored, ...(reasoning ? { reasoning } : {}) };

      for (const call of stored) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          args = { _invalid_json: call.function.arguments };
        }
        yield { type: 'tool.start', id: call.id, name: call.function.name, args };
        const result = await runTool(call.function.name, args, opts.workspace);
        yield {
          type: 'tool.result',
          id: call.id,
          name: call.function.name,
          result: result.output,
          ...(result.diff ? { diff: result.diff } : {}),
        };
        conversation.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result.output,
          name: call.function.name,
        });
      }
      continue;
    }

    yield { type: 'message.complete', content, ...(reasoning ? { reasoning } : {}) };
    return;
  }
}
