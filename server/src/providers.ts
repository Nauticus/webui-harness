import OpenAI from 'openai';

export interface ProviderCreds {
  baseUrl: string; // '' = OpenAI official endpoint
  apiKey: string;
}

export function providerClient(creds: ProviderCreds): OpenAI {
  return new OpenAI({
    apiKey: creds.apiKey || 'unset',
    baseURL: creds.baseUrl || undefined,
  });
}

export interface DetectResult {
  models: string[];
  error: string;
}

/** Call the provider's /models endpoint; never throws (failure => empty list + error). */
export async function detectModels(creds: ProviderCreds, timeoutMs = 10000): Promise<DetectResult> {
  try {
    const res = await providerClient(creds).models.list({
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { models: res.data.map((m) => m.id).sort(), error: '' };
  } catch (err) {
    return { models: [], error: String(err instanceof Error ? err.message : err) };
  }
}
