import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Item } from '../lib/items';
import { fmtTokens } from '../lib/context';
import { onToggle, usePanelOpen } from '../lib/panelState';

type CompactionItem = Extract<Item, { kind: 'compaction' }>;

/**
 * A compaction checkpoint, in two states:
 * - while the summarizer is running: a live line with the token count of
 *   the summary being written
 * - once complete: collapsed to a one-line header (before -> after tokens);
 *   expands to the summary the checkpoint produced (free text, no scroll)
 */
export function CompactionCard({
  item,
  stateKey,
}: {
  item: CompactionItem;
  /** Row key: keeps the reader's expand/collapse choice across virtualization. */
  stateKey: string;
}) {
  const [open, setOpen] = usePanelOpen(stateKey, false);
  if (item.status === 'running') {
    return (
      <div className="flex items-center gap-2 px-1 py-0.5 text-[11px] uppercase tracking-wider text-indigo-300/70">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-400/80" />
        compacting context
        {typeof item.tokensOut === 'number' && (
          <span className="normal-case tabular-nums tracking-normal text-indigo-300/50">
            · ~{fmtTokens(item.tokensOut)} tokens written
          </span>
        )}
      </div>
    );
  }

  if (!item.summary) {
    // Finished without a summary: it was interrupted (stop / error).
    return (
      <div className="flex items-center gap-3 px-2 py-1 text-[10px] uppercase tracking-wider text-slate-600">
        <span className="h-px flex-1 bg-slate-800" />
        ⧉ compaction interrupted
        <span className="h-px flex-1 bg-slate-800" />
      </div>
    );
  }

  const range =
    typeof item.tokensBefore === 'number' && typeof item.tokensAfter === 'number'
      ? `· ${fmtTokens(item.tokensBefore)} → ${fmtTokens(item.tokensAfter)}`
      : '';

  return (
    <details className="group" open={open} onToggle={onToggle(setOpen)}>
      <summary className="flex cursor-pointer select-none items-center gap-3 list-none px-2 py-1 text-[10px] uppercase tracking-wider text-slate-500 transition-colors hover:text-indigo-300 [&::-webkit-details-marker]:hidden">
        <span className="h-px flex-1 bg-slate-800 group-open:bg-slate-700" />
        <span className="flex items-center gap-1.5">
          <span className="text-[9px] text-slate-600 transition-transform group-open:rotate-90">▶</span>
          ⧉ context compacted
          {range && <span className="normal-case tabular-nums tracking-normal text-slate-500/80">{range}</span>}
        </span>
        <span className="h-px flex-1 bg-slate-800 group-open:bg-slate-700" />
      </summary>
      <div className="mx-2 mb-1 mt-2 overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60">
        <div className="prose prose-sm prose-invert max-w-none break-words px-4 py-3 !text-slate-300 [&_code]:rounded [&_code]:bg-slate-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sky-300 [&_pre]:bg-slate-950 [&_pre]:text-slate-300 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_th]:border [&_th]:border-slate-700 [&_td]:border [&_td]:border-slate-700 [&_tr:nth-child(even)_td]:bg-slate-800/40">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.summary}</ReactMarkdown>
        </div>
      </div>
    </details>
  );
}
