import { useMemo, useState } from 'react';

interface DiffLine {
  kind: 'ctx' | 'add' | 'del' | 'hunk';
  text: string;
}
type RenderLine = DiffLine | { kind: 'gap'; count: number };

const PREVIEW_LINES = 20;

/**
 * Parse a unified diff into renderable lines (+/- counts). Header/banner
 * lines before the first @@ hunk are dropped, and long runs of context lines
 * are collapsed to first/last two with a "hidden" gap.
 */
function parseUnifiedDiff(diff: string): { lines: RenderLine[]; adds: number; dels: number } {
  const raw: DiffLine[] = [];
  let adds = 0;
  let dels = 0;
  let inHunk = false;
  for (const l of diff.split('\n')) {
    if (!inHunk) {
      if (l.startsWith('@@')) inHunk = true;
      else continue;
    }
    if (l.startsWith('@@')) raw.push({ kind: 'hunk', text: l });
    else if (l.startsWith('+')) {
      adds++;
      raw.push({ kind: 'add', text: l.slice(1) });
    } else if (l.startsWith('-')) {
      dels++;
      raw.push({ kind: 'del', text: l.slice(1) });
    } else if (l.startsWith(' ') || l === '') raw.push({ kind: 'ctx', text: l.slice(1) });
  }
  const out: RenderLine[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i]!.kind !== 'ctx') {
      out.push(raw[i]!);
      i++;
      continue;
    }
    let j = i;
    while (j < raw.length && raw[j]!.kind === 'ctx') j++;
    const run = raw.slice(i, j);
    if (run.length <= 4) out.push(...run);
    else out.push(run[0]!, run[1]!, { kind: 'gap', count: run.length - 4 }, run[run.length - 2]!, run[run.length - 1]!);
    i = j;
  }
  return { lines: out, adds, dels };
}

const LINE_STYLES: Record<Exclude<RenderLine['kind'], 'gap'>, string> = {
  ctx: 'text-slate-600',
  add: 'bg-emerald-500/10 text-emerald-300',
  del: 'bg-rose-500/10 text-rose-300',
  hunk: 'text-sky-400/80',
};

/**
 * Colorized unified diff that is always visible: small diffs show in full,
 * large ones show the first PREVIEW_LINES with a "show all" toggle.
 */
export function DiffView({ diff, summary }: { diff: string; summary?: string }) {
  const { lines, adds, dels } = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const large = lines.length > PREVIEW_LINES;
  const [expanded, setExpanded] = useState(false);
  const shown = large && !expanded ? lines.slice(0, PREVIEW_LINES) : lines;
  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
        <span className="font-semibold text-emerald-400">+{adds}</span>
        <span className="font-semibold text-rose-400">−{dels}</span>
        {summary && <span className="truncate text-slate-600">{summary}</span>}
      </div>
      <div
        className={`${
          large && !expanded ? '' : 'max-h-72 overflow-auto'
        } border-t border-slate-800/60 font-mono text-[11px] leading-relaxed`}
      >
        {shown.map((l, i) =>
          l.kind === 'gap' ? (
            <div key={i} className="bg-slate-800/40 px-3 py-0.5 text-center text-[10px] text-slate-600">
              ⋯ {l.count} unchanged
            </div>
          ) : l.kind === 'hunk' ? (
            <div key={i} className={`px-3 py-0.5 ${LINE_STYLES.hunk}`}>
              {l.text}
            </div>
          ) : (
            <div key={i} className={`flex ${LINE_STYLES[l.kind]}`}>
              <span className="w-5 shrink-0 select-none text-center opacity-60">
                {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
              </span>
              <span className="whitespace-pre-wrap break-words">{l.text}</span>
            </div>
          )
        )}
      </div>
      {large && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center justify-center gap-1.5 border-t border-slate-800/60 px-3 py-1 text-[11px] text-slate-500 transition-colors hover:text-slate-300"
        >
          {expanded ? '⌃ show less' : `⌄ show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}
