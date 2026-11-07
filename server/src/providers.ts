import OpenAI from 'openai';
import type { ProviderModel } from './db';

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

/* ---------- alias / snapshot grouping ---------- */

/**
 * OpenRouter-style service variants that point at the same underlying model.
 * Unknown tags are deliberately NOT collapsed — Ollama uses `:8b`/`:70b` for
 * genuinely different models.
 */
const VARIANT_SUFFIXES = new Set(['latest', 'free', 'extended', 'nitro']);

/** Dated snapshot suffixes: `gpt-4o-2024-11-20`, `claude-3-5-sonnet-20241022`. */
const DATE_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|\d{8})(?:-\d{1,2})?$/;

/**
 * Normalize a model id to its underlying-model base id:
 * - known service variants collapse (`openai/gpt-4o:free` -> `openai/gpt-4o`)
 * - dated snapshots collapse to their alias (`gpt-4o-2024-11-20` -> `gpt-4o`)
 * - everything else is its own group
 */
export function modelBaseId(id: string): string {
  let base = id;
  const ci = base.indexOf(':');
  if (ci !== -1 && VARIANT_SUFFIXES.has(base.slice(ci + 1))) base = base.slice(0, ci);
  return base.replace(DATE_SUFFIX, '');
}

export interface ModelGroup {
  /** Canonical id to send to the provider (no variant suffix, no date). */
  id: string;
  /** Other detected ids that normalize to the same base model. */
  aliases: string[];
  /** Context window configured on the canonical id, when set. */
  contextWindow?: number;
}

/** Lower score = more canonical: no variant tag, no date suffix, shorter. */
function canonicalScore(id: string): number {
  return (id.includes(':') ? 2 : 0) + (DATE_SUFFIX.test(id) ? 1 : 0);
}

/**
 * Group detected models by base id (order of first appearance is kept).
 * The group id is the most canonical member; the rest are listed as aliases.
 */
export function groupModels(models: ProviderModel[]): ModelGroup[] {
  const byBase = new Map<string, ProviderModel[]>();
  for (const m of models) {
    const base = modelBaseId(m.id);
    const list = byBase.get(base);
    if (list) list.push(m);
    else byBase.set(base, [m]);
  }
  const groups: ModelGroup[] = [];
  for (const members of byBase.values()) {
    const canonical = [...members].sort(
      (a, b) => canonicalScore(a.id) - canonicalScore(b.id) || a.id.length - b.id.length || (a.id < b.id ? -1 : 1)
    )[0]!;
    groups.push({
      id: canonical.id,
      aliases: members.filter((m) => m.id !== canonical.id).map((m) => m.id),
      ...(canonical.contextWindow !== undefined ? { contextWindow: canonical.contextWindow } : {}),
    });
  }
  return groups;
}
