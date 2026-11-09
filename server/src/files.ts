import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';

/**
 * Workspace file lookup for the composer's `@` picker.
 *
 * Everything here is addressed *relative to a project root* (the same directory
 * the agent's tools are sandboxed to), so the client never has to know or send
 * an absolute path and cannot ask for anything outside that root. Two shapes:
 *
 *   listWorkspace  — one directory, dirs first. The starting state of the picker.
 *   searchWorkspace — a recursive fuzzy path search. The state once you type.
 */

export interface FileEntry {
  /** POSIX-style path relative to the root, no trailing slash. */
  path: string;
  type: 'file' | 'dir';
}

export interface ListResult {
  dir: string;
  entries: FileEntry[];
  /** True when the directory held more entries than the limit. */
  truncated: boolean;
}

export interface SearchResult extends ListResult {
  dir: '';
}

/**
 * Directories that are never worth a click or a match: generated, huge, and
 * never the file someone means when they type `@`. Skipping them during the
 * walk is also what keeps a search on a real repo instant.
 */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  'target',
  '.gradle',
  '.terraform',
]);

/** Entries examined by one search before it gives up. A safety valve on a
 *  pathological tree, not a tuning knob — normal repos never reach it. */
export const MAX_SCANNED = 40_000;
/** How deep the walk goes. Deeper than this is not a source tree. */
export const MAX_DEPTH = 14;
/** Entries the picker can show at once. */
export const RESULT_LIMIT = 120;

/**
 * Resolve `rel` inside `root`, refusing to leave it.
 *
 * Same rule as the tool sandbox: an absolute or escaping path is a 400, not a
 * directory listing of the machine. The API has no auth, so this is the only
 * thing standing between `?dir=../../..` and a read of the whole filesystem.
 */
export function resolveInside(root: string, rel: string): string {
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw Object.assign(new Error(`path escapes the project directory: ${rel}`), { statusCode: 400 });
  }
  return abs;
}

/** Sort order for a listing: directories first, then files, both alphabetical. */
function byTypeThenName(a: FileEntry, b: FileEntry): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.path.localeCompare(b.path);
}

/** One directory, shallow. Dots stay hidden unless you look for them. */
export async function listWorkspace(root: string, relDir = '', limit = RESULT_LIMIT): Promise<ListResult> {
  const abs = resolveInside(root, relDir);
  const dirents = await fs.readdir(abs, { withFileTypes: true }).catch((err) => {
    throw Object.assign(new Error(`cannot read directory: ${abs}`), { statusCode: 400, cause: err });
  });
  const entries: FileEntry[] = [];
  for (const e of dirents) {
    if (e.isSymbolicLink()) continue; // never follow one out of the sandbox
    if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue;
    if (e.name.startsWith('.')) continue;
    entries.push({
      path: path.posix.join(relDir.replace(/\\/g, '/'), e.name),
      type: e.isDirectory() ? 'dir' : 'file',
    });
  }
  entries.sort(byTypeThenName);
  return { dir: relDir.replace(/\\/g, '/'), entries: entries.slice(0, limit), truncated: entries.length > limit };
}

/**
 * Score a relative path against a query: higher is better, null is no match.
 *
 * The shape of the ranking is what makes a picker feel right — a query is
 * usually a basename fragment (`composer`), sometimes a path fragment
 * (`src/lib`), occasionally a fuzzy one (`cmpsr`). Anything a person could
 * have meant beats anything they could not, and ties go to the shortest,
 * shallowest path, because `client/src/api.ts` is a likelier target than
 * `client/src/components/dialogs/legacy/old/api.ts`.
 */
export function scorePath(rel: string, query: string): number | null {
  const p = rel.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 0;

  const base = p.slice(p.lastIndexOf('/') + 1);
  const dirs = p.split('/').length - 1;

  let score: number;
  if (base === q) score = 1000;
  else if (base.startsWith(q)) score = 800;
  else if (p.startsWith(q)) score = 700;
  else if (base.includes(q)) score = 550;
  else if (p.includes(q)) score = 400;
  else {
    // Fallback: the query's characters in order, anywhere in the path.
    let i = 0;
    for (const ch of p) if (ch === q[i]) i++;
    if (i < q.length) return null;
    score = 150;
  }

  // A hit at the start of a path segment is what typing a folder name means.
  const boundary = p.includes(`/${q}`) || p.startsWith(q);
  if (boundary) score += 120;
  return score - dirs * 10;
}

/** Rank relative paths by score, best first; ties go shallow-then-short. */
export function rankPaths<T extends { path: string }>(items: T[], query: string, limit = RESULT_LIMIT): T[] {
  const scored = items
    .map((it) => ({ it, s: scorePath(it.path, query) }))
    .filter((x): x is { it: T; s: number } => x.s !== null);
  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    const da = a.it.path.split('/').length;
    const db = b.it.path.split('/').length;
    if (da !== db) return da - db;
    return a.it.path.localeCompare(b.it.path);
  });
  return scored.slice(0, limit).map((x) => x.it);
}

/**
 * Recursive fuzzy search over a workspace.
 *
 * Both files and directories are candidates — `@src/lib/` is a real thing to
 * mean — and a directory's path is scored so a folder match sorts with its
 * contents rather than above them.
 */
export async function searchWorkspace(
  root: string,
  query: string,
  limit = RESULT_LIMIT,
  maxScanned = MAX_SCANNED
): Promise<SearchResult> {
  const base = path.resolve(root);
  const found: FileEntry[] = [];
  let scanned = 0;
  let truncated = false;
  // Explicit stack: recursion would hold a frame per directory on a wide tree.
  const stack: { abs: string; rel: string; depth: number }[] = [{ abs: base, rel: '', depth: 0 }];

  while (stack.length > 0) {
    const { abs, rel, depth } = stack.pop()!;
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue; // unreadable subdirectory (permissions, a socket) is not an error
    }
    for (const e of dirents) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue;
      // Hidden entries only count when the query is looking for them.
      if (e.name.startsWith('.') && !query.startsWith('.')) continue;
      scanned++;
      if (scanned > maxScanned) {
        truncated = true;
        break;
      }
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (scorePath(childRel, query) !== null) {
        found.push({ path: childRel, type: e.isDirectory() ? 'dir' : 'file' });
      }
      if (e.isDirectory() && depth + 1 < MAX_DEPTH) stack.push({ abs: path.join(abs, e.name), rel: childRel, depth: depth + 1 });
    }
    if (truncated) break;
  }

  // "Truncated" means the picker is hiding matches, whichever reason: more
  // hits than the list can show, or a tree too big to finish scanning.
  return { dir: '', entries: rankPaths(found, query, limit), truncated: truncated || found.length > limit };
}
