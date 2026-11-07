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
}

export type AgentEvent =
  | { type: 'message.delta'; text: string }
  | { type: 'tool.round'; content: string; toolCalls: StoredToolCall[] }
  | { type: 'tool.start'; id: string; name: string; args: unknown }
  | { type: 'tool.result'; id: string; name: string; result: string }
  | { type: 'message.complete'; content: string }
  | { type: 'error'; message: string };

const MAX_STEPS = 12;

const SYSTEM_PROMPT = (workspace: string) =>
  `You are a local AI agent. Your working directory is ${workspace}. You can run shell commands and read/write files inside it (and its subdirectories) — that is the only place you may write. Use tools to actually do the work; never claim to have done something you did not. Be concise in your final answer.`;

export const DEFAULT_MODEL = () => process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

/**
 * Run one full agent turn: LLM -> tool calls -> LLM -> ... until it replies
 * with plain text (or the step budget runs out). Streams events as it goes.
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

  for (let step = 0; step < MAX_STEPS; step++) {
    const stream = await client.chat.completions.create(
      {
        model,
        messages: conversation as unknown as ChatCompletionMessageParam[],
        tools: TOOLS,
        stream: true,
      },
      { signal: opts.signal }
    );

    let content = '';
    const rawCalls: { index: number; id?: string; name?: string; args: string }[] = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        content += delta.content;
        yield { type: 'message.delta', text: delta.content };
      }
      for (const tc of delta?.tool_calls ?? []) {
        const slot = rawCalls[tc.index] ?? (rawCalls[tc.index] = { index: tc.index, args: '' });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
    }

    const calls = rawCalls.filter((c) => c.id && c.name);
    if (calls.length > 0) {
      const stored: StoredToolCall[] = calls.map((c) => ({
        id: c.id!,
        type: 'function',
        function: { name: c.name!, arguments: c.args },
      }));
      conversation.push({ role: 'assistant', content: content || null, tool_calls: stored });
      yield { type: 'tool.round', content, toolCalls: stored };

      for (const call of stored) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          args = { _invalid_json: call.function.arguments };
        }
        yield { type: 'tool.start', id: call.id, name: call.function.name, args };
        const result = await runTool(call.function.name, args, opts.workspace);
        yield { type: 'tool.result', id: call.id, name: call.function.name, result };
        conversation.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result,
          name: call.function.name,
        });
      }
      continue;
    }

    yield { type: 'message.complete', content };
    return;
  }
  yield { type: 'error', message: `agent stopped after ${MAX_STEPS} steps without a final answer` };
}
