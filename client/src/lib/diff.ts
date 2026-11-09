/**
 * The diff text → rows, as pure functions: no DOM, no wasm, nothing to stub.
 * Kept apart from the component the way `highlight-core.ts` is kept apart from
 * `highlight.ts`, so the rules can be unit-tested on their own.
 */

export type DiffKind = 'ctx' | 'add' | 'del' | 'hunk';

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** Line number in the file before / after the change — what the gutters show. */
  pre?: number;
  post?: number;
  /**
   * Index into the pre-/post-image the parse builds. Not the same as the line
   * number: the images hold only the lines the diff mentions, while these
   * numbers count the file. The tokens come from here.
   */
  preAt?: number;
  postAt?: number;
}

export interface Diff {
  lines: DiffLine[];
  adds: number;
  dels: number;
  /** The file as it looks after (context + additions) and before (context + deletions). */
  post: string;
  pre: string;
}

/** `@@ -a,b +c,d @@` — where each side of the file restarts. */
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a unified diff into renderable rows (+/- counts). Header/banner lines
 * before the first @@ hunk are dropped; everything after it is kept, so the view
 * shows the whole change however large the diff is.
 *
 * Each row carries both its file line numbers and its line number in the two
 * images the diff implies — the post-image (context + additions) and the
 * pre-image (context + deletions), the file as it looks after and before. A diff
 * row is a fragment, and a fragment alone does not parse: `} else {` only makes
 * sense inside the file it came from. So the two images are what gets handed to
 * the parser, one parse each, and the tokens come back per row.
 */
export function parseUnifiedDiff(diff: string): Diff {
  const lines: DiffLine[] = [];
  const post: string[] = [];
  const pre: string[] = [];
  let adds = 0;
  let dels = 0;
  let inHunk = false;
  let preNo = 0;
  let postNo = 0;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      // The next file in the same output: its own headers follow, then its own
      // hunk. Without this a multi-file `git diff` reads `--- a/next.ts` as a
      // deleted line.
      inHunk = false;
      continue;
    }
    if (raw.startsWith('@@')) {
      inHunk = true;
      const h = HUNK.exec(raw);
      // Every line is kept, so the counters cannot drift; a header we cannot
      // read only costs the gutter numbers, never a row.
      preNo = h ? Number(h[1]) : preNo + 1;
      postNo = h ? Number(h[2]) : postNo + 1;
      lines.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (!inHunk) continue; // the file header is not source
    const text = raw.slice(1);
    if (raw.startsWith('+')) {
      adds++;
      lines.push({ kind: 'add', text, post: postNo++, postAt: post.push(text) - 1 });
    } else if (raw.startsWith('-')) {
      dels++;
      lines.push({ kind: 'del', text, pre: preNo++, preAt: pre.push(text) - 1 });
    } else if (raw.startsWith(' ') || raw === '') {
      lines.push({
        kind: 'ctx',
        text,
        pre: preNo++,
        post: postNo++,
        preAt: pre.push(text) - 1,
        postAt: post.push(text) - 1,
      });
    }
  }

  return { lines, adds, dels, post: post.join('\n'), pre: pre.join('\n') };
}

/**
 * Which file a diff touches, from its own header. Lets a diff that arrives as
 * plain text — `git diff` in a bash card — still be coloured by the right
 * grammar, with nothing else to tell us.
 */
export function pathFromDiff(diff: string): string {
  const git = /^diff --git a\/.* b\/(.*)$/m.exec(diff)?.[1];
  if (git) return git.trim();
  const plus = /^\+\+\+ b\/(.*)$/m.exec(diff)?.[1];
  return plus ? plus.trim() : '';
}

/** One side of a split row: a line of the diff, or a pad where one side is short. */
export type Cell = { kind: 'ctx' | 'add' | 'del' | 'blank'; line?: DiffLine };

export type SplitRow = { kind: 'hunk'; text: string } | { kind: 'cells'; left: Cell; right: Cell };

/**
 * Lay the same rows out side by side. A context line stands on both sides; a
 * hunk header spans them; a changed block pairs its deletions with its
 * additions by position and pads whichever side ran short.
 *
 * The pairing never invents, drops or reorders a line: read down the left column
 * and you have the pre-image, down the right and you have the post-image.
 */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (line.kind === 'hunk') {
      rows.push({ kind: 'hunk', text: line.text });
      i++;
      continue;
    }
    if (line.kind === 'ctx') {
      const cell: Cell = { kind: 'ctx', line };
      rows.push({ kind: 'cells', left: cell, right: cell });
      i++;
      continue;
    }
    // A changed block: however its lines interleave, deletions pair with
    // additions in the order each side lists them.
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    let j = i;
    while (j < lines.length && (lines[j]!.kind === 'add' || lines[j]!.kind === 'del')) {
      (lines[j]!.kind === 'del' ? dels : adds).push(lines[j]!);
      j++;
    }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const left = dels[k];
      const right = adds[k];
      rows.push({
        kind: 'cells',
        left: left ? { kind: 'del', line: left } : { kind: 'blank' },
        right: right ? { kind: 'add', line: right } : { kind: 'blank' },
      });
    }
    i = j;
  }
  return rows;
}
