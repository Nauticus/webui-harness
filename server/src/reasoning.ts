/**
 * Reasoning effort: how hard a thinking-capable model should reason.
 * Stored per session ('' = auto, i.e. the provider's default). Each
 * provider family accepts it in a different shape, so this module maps
 * (provider base URL, model, effort) -> extra request body params.
 *
 * The value is passed through as-is for the endpoint's shape — no
 * per-model gating. If a provider rejects the value for a particular
 * model (e.g. `xhigh` on an older gpt-5.x), the API error surfaces in
 * the chat and auto ('') is the fallback.
 */

export type ReasoningEffort = '' | 'low' | 'medium' | 'high' | 'xhigh';

export const REASONING_EFFORTS: ReasoningEffort[] = ['', 'low', 'medium', 'high', 'xhigh'];

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === 'string' && (REASONING_EFFORTS as string[]).includes(v);
}

/**
 * Extra chat-completions body params for the given effort. Returns {} when
 * nothing should be sent (auto or an unrecognized value).
 */
export function effortExtraParams(
  baseUrl: string,
  model: string,
  effort: string
): Record<string, unknown> {
  if (!isReasoningEffort(effort) || effort === '') return {};
  const url = (baseUrl || '').toLowerCase();
  void model; // value is passed through for any model

  // OpenAI official endpoint (or blank base_url = official) and generic
  // OpenAI-compatible servers share the standard field.
  if (url.includes('openrouter.ai')) {
    // OpenRouter takes the nested form.
    return { reasoning: { effort } };
  }
  if (url.includes('ollama') || url.includes(':11434')) {
    // Ollama's OpenAI-compatible API has no effort levels — `think` only
    // toggles thinking on. An explicit effort means "use thinking".
    return { think: true };
  }
  if (url.includes('googleapis.com') || url.includes('aiplatform')) {
    // Google OpenAI-compatible endpoints take thinking_config.
    return { thinking_config: { thinking_level: effort } };
  }
  return { reasoning_effort: effort };
}
