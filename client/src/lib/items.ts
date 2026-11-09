import type { MessageRow } from '../api';

/** One rendered block in the chat: a streamed-in or loaded-from-history unit. */
export type Item =
  | { kind: 'user'; content: string }
  | { kind: 'assistant'; content: string }
  | { kind: 'thinking'; content: string; done: boolean }
  | {
      kind: 'tool';
      id: string;
      name: string;
      args?: unknown;
      result?: string;
      ok?: boolean;
      diff?: string;
      /** Which shell ran it — the command line is coloured as that language. */
      shell?: 'bash' | 'powershell';
    }
  | { kind: 'error'; message: string }
  | {
      kind: 'compaction';
      /** running = summarizer in flight; done = finished (summary present unless interrupted). */
      status: 'running' | 'done';
      tokensBefore?: number;
      tokensAfter?: number;
      /** Estimated tokens of the summary written so far (live, while running). */
      tokensOut?: number;
      summary?: string;
    }
  | { kind: 'stopped' };

/**
 * A rendered row: a chat item, plus the display-only "waiting for the model"
 * placeholder. The placeholder never enters an Item list (it is not an event
 * and is never persisted) — it only exists in the view's row list.
 */
export type ChatRow = Item | { kind: 'busy' };

/**
 * True while a turn is running but nothing on screen is visibly growing, so
 * the transcript itself has to say "working". Each case names what the user
 * is waiting behind: the first token, a settled thinking block, the next LLM
 * call after a tool finished, or a compaction that just landed. Anything
 * already streaming (assistant text, an open thinking block, a running tool
 * or compaction card) has its own live signal and needs no placeholder.
 */
export function isAwaitingModel(items: Item[], busy: boolean): boolean {
  if (!busy) return false;
  const last = items[items.length - 1];
  if (!last) return true;
  switch (last.kind) {
    case 'user':
      return true;
    case 'thinking':
      return last.done;
    case 'tool':
      return last.result !== undefined;
    case 'compaction':
      return last.status === 'done';
    default:
      return false;
  }
}

/** The items to render: the chat items, plus the placeholder when waiting. */
export function toRows(items: Item[], busy: boolean): ChatRow[] {
  return isAwaitingModel(items, busy) ? [...items, { kind: 'busy' }] : items;
}

/**
 * Stable key for a rendered row. Tool rows key on the tool-call id, which is
 * the same string live and after a reload (see `rowsToItems`), so a card keeps
 * its identity — and its measured height — across a session reopen. Everything
 * else is positional: items are append-only within a session.
 */
export function rowKey(row: ChatRow, index: number): string {
  if (row.kind === 'busy') return 'busy';
  if (row.kind === 'tool') return `tool:${row.id}`;
  return `${row.kind}:${index}`;
}

export function rowsToItems(rows: MessageRow[]): Item[] {
  const items: Item[] = [];
  for (const r of rows) {
    let meta: {
      tool_calls?: unknown[];
      tool_call_id?: string;
      name?: string;
      args?: unknown;
      reasoning?: string;
      diff?: string;
      stopped?: boolean;
      ok?: boolean;
      shell?: string;
      tokensBefore?: number;
      tokensAfter?: number;
    } = {};
    if (r.meta) {
      try {
        meta = JSON.parse(r.meta);
      } catch {
        meta = {};
      }
    }
    if (r.role === 'user') items.push({ kind: 'user', content: r.content });
    else if (r.role === 'compaction') {
      // A compaction record only changes what the model sees; in the chat it
      // is a checkpoint marker whose expansion shows the produced summary.
      items.push({
        kind: 'compaction',
        status: 'done',
        summary: r.content,
        ...(typeof meta.tokensBefore === 'number' ? { tokensBefore: meta.tokensBefore } : {}),
        ...(typeof meta.tokensAfter === 'number' ? { tokensAfter: meta.tokensAfter } : {}),
      });
    } else if (r.role === 'assistant') {
      if (meta.reasoning) items.push({ kind: 'thinking', content: meta.reasoning, done: true });
      if (r.content) items.push({ kind: 'assistant', content: r.content });
      if (meta.stopped === true) items.push({ kind: 'stopped' });
    } else if (r.role === 'tool') {
      items.push({
        kind: 'tool',
        // The tool-call id, not the database row id: it is what the live
        // stream uses, so a card keeps the same identity after a reopen.
        id: meta.tool_call_id ?? String(r.id),
        name: meta.name ?? 'tool',
        args: meta.args,
        result: r.content,
        ...(meta.ok === false ? { ok: false } : {}),
        ...(meta.diff ? { diff: meta.diff } : {}),
        ...(meta.shell === 'powershell' || meta.shell === 'bash' ? { shell: meta.shell } : {}),
      });
    }
  }
  return items;
}

export const TOOL_ICONS: Record<string, string> = {
  bash: '💻',
  read_file: '📖',
  write_file: '✍️',
  edit_file: '🪄',
  list_dir: '📁',
};

/**
 * Did this tool call fail? New records say so explicitly (`ok: false`). Rows
 * written before that flag existed fall back to the old convention — every
 * server failure used to start its output with "error:" — so old history is
 * still painted honestly.
 */
export function toolFailed(item: { result?: string; ok?: boolean }): boolean {
  if (item.result === undefined) return false;
  return item.ok === undefined ? item.result.startsWith('error') : !item.ok;
}

export function formatArgs(args: unknown): string {
  const s = JSON.stringify(args);
  return s && s.length > 80 ? s.slice(0, 80) + '…' : s;
}

/** One-line human target for a tool call (path / command), for the card summary. */
export function toolTarget(name: string, args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  switch (name) {
    case 'bash':
      return typeof a.command === 'string' ? a.command : '';
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return typeof a.path === 'string' ? a.path : '';
    case 'list_dir':
      return typeof a.path === 'string' && a.path ? a.path : '.';
    default:
      return formatArgs(args);
  }
}

/**
 * Explicit skill invocation in a user message: `/skill:name [task]`.
 * Mirrors the server's INVOCATION_RE.
 */
export function parseSkillInvocation(content: string): { name: string; task: string } | null {
  const m = /^\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?:[ \t]+([\s\S]*?))[ \t]*$/.exec(content.trim());
  if (!m) return null;
  return { name: m[1]!, task: (m[2] ?? '').trim() };
}

/** True when a file path points at a SKILL.md (absolute or relative). */
export function isSkillFile(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? '';
  return base === 'SKILL.md' || base === 'skill.md';
}

/** Best-effort skill directory name from a SKILL.md path. */
export function skillDirName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? (parts[parts.length - 2] ?? '') : '';
}
