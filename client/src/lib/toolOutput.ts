/**
 * What a chunk of tool output actually is.
 *
 * Command output is arbitrary text, so the only honest detections are the ones
 * that can be decided from the text itself: a unified diff and a JSON document.
 * Anything else stays plain — colouring a build log as if it were source would
 * be decoration at the cost of trust.
 */

/** A unified diff: needs a hunk header *and* a file header, so a log line that
 *  merely mentions `@@` does not turn into a diff view. */
export function looksLikeDiff(text: string): boolean {
  const hunk = /(^|\n)@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(text);
  const files = /(^|\n)(diff --git |--- a\/|\+\+\+ b\/)/.test(text);
  return hunk && files;
}

const MAX_JSON_CHARS = 200_000;

/** The value, if the whole text is one JSON document. `undefined` otherwise —
 *  including for a sentence that merely contains JSON. */
export function asJson(text: string): unknown | undefined {
  const t = text.trim();
  if (!t || t.length > MAX_JSON_CHARS) return undefined;
  const open = t[0];
  if (open !== '{' && open !== '[') return undefined;
  const close = open === '{' ? '}' : ']';
  if (t[t.length - 1] !== close) return undefined;
  try {
    const parsed: unknown = JSON.parse(t);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}
