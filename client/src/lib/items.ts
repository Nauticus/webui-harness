import type { MessageRow } from '../api';

/** One rendered block in the chat: a streamed-in or loaded-from-history unit. */
export type Item =
  | { kind: 'user'; content: string }
  | { kind: 'assistant'; content: string }
  | { kind: 'thinking'; content: string; done: boolean }
  | { kind: 'tool'; id: string; name: string; args?: unknown; result?: string; diff?: string }
  | { kind: 'error'; message: string }
  | { kind: 'compaction' }
  | { kind: 'stopped' };

export function rowsToItems(rows: MessageRow[]): Item[] {
  const items: Item[] = [];
  for (const r of rows) {
    let meta: { tool_calls?: unknown[]; name?: string; args?: unknown; reasoning?: string; diff?: string; stopped?: boolean } = {};
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
      // is a divider marking where the context was summarized.
      items.push({ kind: 'compaction' });
    } else if (r.role === 'assistant') {
      if (meta.reasoning) items.push({ kind: 'thinking', content: meta.reasoning, done: true });
      if (r.content) items.push({ kind: 'assistant', content: r.content });
      if (meta.stopped === true) items.push({ kind: 'stopped' });
    } else if (r.role === 'tool') {
      items.push({
        kind: 'tool',
        id: String(r.id),
        name: meta.name ?? 'tool',
        args: meta.args,
        result: r.content,
        ...(meta.diff ? { diff: meta.diff } : {}),
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
