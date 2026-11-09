/**
 * How much output a card shows before it stops.
 *
 * The chat view is the only scrollable element in the app, so a card cannot
 * offer a scrollbar of its own — it shows what fits and hands the rest to the
 * expand dialog. `lines` is what a card has room for at reading size; `chars`
 * is the backstop for output with no newlines in it (a minified bundle, a
 * base64 blob), which would otherwise put every byte in the DOM just because
 * line counting found nothing to stop at.
 */
export const OUTPUT_BUDGET = { lines: 14, chars: 20_000 };

export interface Clip {
  /** The part that fits. Never cuts mid-line unless the budget ran out there. */
  shown: string;
  /** Lines left out. Zero when the budget cut inside the first line. */
  hidden: number;
  /** Whether anything was left out at all. */
  clipped: boolean;
}

/**
 * The first lines of `text` that fit a budget, whole lines only.
 *
 * Lines are never split, so what a card renders is always text a highlighter
 * can parse on its own — clipping a `.ts` result mid-statement would show a
 * broken fragment where the grammar no longer makes sense.
 */
export function clipText(text: string, budget = OUTPUT_BUDGET): Clip {
  const lines = text.split('\n');
  const kept: string[] = [];
  let cut = false;
  let chars = 0;

  for (const line of lines) {
    if (kept.length >= budget.lines) break;
    if (chars > 0 && chars + line.length + 1 > budget.chars) break;
    // Nothing kept yet and one line is already over budget: show its beginning,
    // because an empty card is worse than a partial one.
    if (chars === 0 && line.length > budget.chars) {
      kept.push(line.slice(0, budget.chars));
      cut = true;
      break;
    }
    kept.push(line);
    chars += line.length + 1;
  }

  const hidden = lines.length - kept.length;
  return { shown: kept.join('\n'), hidden, clipped: hidden > 0 || cut };
}
