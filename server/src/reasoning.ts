/**
 * Reasoning effort: how hard a thinking-capable model should reason.
 * Stored per session ('' = auto, i.e. the provider's default). Each
 * provider family accepts it in a different shape, so this module maps
 * (provider base URL, model, effort) -> extra request body params.
 *
 * The mapping is conservative: it only adds params the provider family is
 * known to accept, and skips them where sending them would 400 (OpenAI
 * rejects `reasoning_effort` on non-reasoning models).
 */

export type ReasoningEffort = '' | 'low' | 'medium' | 'high';

export const REASONING_EFFORTS: ReasoningEffort[] = ['', 'low', 'medium', 'high'];

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === 'string' && (REASONING_EFFORTS as string[]).includes(v);
}

/** OpenAI reasoning-model id shapes (o1/o3/o4 series, gpt-5 family). */
const OPENAI_REASONING_MODEL = /(^|\/)o[134](-|\.|$)|gpt-5/i;

/**
 * Extra chat-completions body params for the given effort. Returns {} when
 * nothing should be sent (auto, an unrecognized value, or a model the
 * provider won't accept it for).
 */
export function effortExtraParams(
  baseUrl: string,
  model: string,
  effort: string
): Record<string, unknown> {
  if (!isReasoningEffort(effort) || effort === '') return {};
  const url = (baseUrl || '').toLowerCase();

  // OpenAI official endpoint (or blank base_url = official): strict — the
  // API 400s when `reasoning_effort` is sent to a non-reasoning model.
  if (url === '' || url.includes('api.openai.com')) {
    return OPENAI_REASONING_MODEL.test(model) ? { reasoning_effort: effort } : {};
  }

  // OpenRouter: accepts `reasoning: { effort }`; ignored for models that
  // don't support effort levels.
  if (url.includes('openrouter.ai')) {
    return { reasoning: { effort } };
  }

  // Ollama's OpenAI-compatible API has no effort levels — `think` only
  // toggles thinking on. An explicit effort means "use thinking".
  if (url.includes('ollama') || url.includes(':11434')) {
    return { think: true };
  }

  // Google (AI Studio / Vertex OpenAI-compatible endpoints): Gemini 3 takes
  // thinking_level (low/medium/high map 1:1).
  if (url.includes('googleapis.com') || url.includes('aiplatform')) {
    return model.toLowerCase().startsWith('gemini') ? { thinking_config: { thinking_level: effort } } : {};
  }

  // Generic OpenAI-compatible servers (local runtimes, proxies): the
  // standard field; servers without support ignore unknown body fields.
  return { reasoning_effort: effort };
}
