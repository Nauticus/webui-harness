/**
 * The `@file` token in a prompt.
 *
 * The picker is a dialog, so it needs to know *where* the token it is filling
 * lives: the text keeps being the source of truth (the dialog never edits it
 * behind the composer's back), and the composer owns the caret. All of that
 * arithmetic is here, where it can be tested without a DOM.
 */

export interface MentionToken {
  /** Index of the `@` in the text. */
  start: number;
  /** Index just past what has been typed — the caret while the token is live. */
  end: number;
  /** What is after the `@` so far; the picker's initial query. */
  query: string;
}

/** What an `@` may follow to count as the start of a reference. An email in the
 *  middle of a sentence (`me@example.com`) is not someone pointing at a file. */
const BOUNDARY = /[\s([{<>"']/;

/** Characters that end a path. A path with a parenthesis in it is rare enough
 *  to trade away for a token that always stops where a word does. */
const STOP_CHARS = '@\'"`;,()[]{}<>';

/** True when `ch` can be part of an `@path` token. Nothing at all (past the end
 *  of the text) is not a path character. */
export function isPathChar(ch: string | undefined): boolean {
  return ch !== undefined && !/\s/.test(ch) && !STOP_CHARS.includes(ch);
}

/**
 * The `@` token the caret is sitting in, or null.
 *
 * Scanning back stops at whitespace or punctuation, so the token is the word
 * under the caret rather than the whole message — and an `@` inside a word is
 * never a reference.
 */
export function findMention(text: string, caret: number): MentionToken | null {
  let i = Math.max(0, Math.min(caret, text.length));
  while (i > 0) {
    const ch = text[i - 1];
    if (ch === '@') {
      // The @ has to start the word, not sit inside it: `me@example.com` is an
      // address, not a pointer at a file called example.com.
      if (i - 1 > 0 && isPathChar(text[i - 2])) return null;
      return { start: i - 1, end: caret, query: text.slice(i, caret) };
    }
    if (!isPathChar(ch)) return null;
    i--;
  }
  return null;
}

/** True when the character just typed at `caret` opens a reference. */
export function justOpenedMention(text: string, caret: number): boolean {
  if (text[caret - 1] !== '@') return false;
  return caret - 1 === 0 || !isPathChar(text[caret - 2]);
}

/**
 * Replace the token with `@path`, leaving the caret after it so typing continues.
 *
 * The spaces around the insertion are what make the result readable: a
 * reference glued to the previous word reads as one long token, and the model
 * would have to guess where the path ends.
 */
export function insertMention(
  text: string,
  token: { start: number; end: number },
  path: string
): { text: string; caret: number } {
  const lead = token.start > 0 && !BOUNDARY.test(text[token.start - 1] ?? '') ? ' ' : '';
  // A space already there is enough; at the end of the text (or glued to the
  // next word) one has to be added, or the path runs into what follows.
  const nextChar = text[token.end] ?? '';
  const trail = nextChar !== '' && /\s/.test(nextChar) ? '' : ' ';
  const inserted = `${lead}@${path}${trail}`;
  return {
    text: text.slice(0, token.start) + inserted + text.slice(token.end),
    // When the space was already there, the caret goes past it: typing on
    // should continue the sentence, not jam a word against the path.
    caret: token.start + inserted.length + (trail === '' ? 1 : 0),
  };
}

/** The references in a finished message, in order. Used to highlight them. */
export function findMentions(text: string): string[] {
  return splitMentions(text)
    .filter((s) => s.mention)
    .map((s) => s.text.slice(1));
}

/** A message cut into plain text and `@path` references. A bare `@` is someone
 *  addressing the room, not a path, so a reference needs at least one
 *  character after it. */
export function splitMentions(text: string): { text: string; mention: boolean }[] {
  const out: { text: string; mention: boolean }[] = [];
  const re = /(^|[\s([{<>"'])@([^\s@()[\]{}<>"'`;,]+)/g;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [, before = '', path = ''] = m;
    const start = m.index + before.length;
    if (start > at) out.push({ text: text.slice(at, start), mention: false });
    out.push({ text: `@${path}`, mention: true });
    at = start + path.length + 1;
  }
  if (at < text.length) out.push({ text: text.slice(at), mention: false });
  return out;
}
