import type { ContextUsage } from '../api';

/** Compact token count: 128000 -> '128k', 1500000 -> '1.5M'. */
export function fmtTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return `${Math.max(1, Math.round(tokens / 1000))}k`;
}

export interface ContextReadout {
  /** Nothing to show until a window is known. */
  visible: boolean;
  /** 0–100, clamped. */
  pct: number;
  /** Compaction will trigger on the next turn. */
  armed: boolean;
  /** The window is gone. */
  full: boolean;
  /** '12k/200k' */
  label: string;
  /** Tooltip with the exact numbers. */
  title: string;
  /** Tailwind background class for the usage bar. */
  tone: string;
}

/**
 * How full the model's context is — decided in one place so the bar above the
 * composer, the chip in the corner and their tooltips cannot drift apart.
 * `threshold` is a token count (the server's compaction trigger), not a
 * percentage; comparing it against a percentage made it unreachable.
 */
export function contextUsage(c: ContextUsage): ContextReadout {
  const pct = c.window > 0 ? Math.max(0, Math.min(100, (c.tokens / c.window) * 100)) : 0;
  const armed = c.threshold > 0 && c.tokens >= c.threshold;
  const full = c.window > 0 && c.tokens >= c.window;
  return {
    visible: c.window > 0,
    pct,
    armed,
    full,
    label: `${fmtTokens(c.tokens)}/${fmtTokens(c.window)}`,
    title:
      `context ${pct.toFixed(0)}% used (${c.tokens.toLocaleString()} / ${c.window.toLocaleString()} tokens)` +
      (armed ? ' — compaction armed' : ''),
    tone: full ? 'bg-red-500' : armed ? 'bg-amber-500' : 'bg-indigo-500',
  };
}
