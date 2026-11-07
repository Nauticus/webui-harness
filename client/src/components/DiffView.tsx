import { useMemo, useState } from 'react';

interface DiffLine {
  kind: 'ctx' | 'add' | 'del' | 'hunk';
  text: string;
}

/** Parse a unified diff into renderable lines (+/- counts). Header lines are dropped. */
function parseUnifiedDiff(diff: string): { lines: DiffLine[]; adds: number; dels: number } {
  const lines: DiffLine[] = [];
  let adds = 0;
  let dels = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('@@')) {
      lines.push({ kind: 'hunk', text: l });
    } else if (l.startsWith('+')) {
      adds++;
      lines.push({ kind: 'add', text: l.slice(1) });
    } else if (l.startsWith('-')) {
      dels++;
      lines.push({ kind: 'del', text: l.slice(1) });
    } else if (l.startsWith(' ') || l === '') {
      lines.push({ kind: 'ctx', text: l.slice(1) });
    }
    // 'diff --git', '--- a/…', '+++ b/…', 'Index: …', '=====' banner lines are skipped
  }
  return { lines, adds, dels };
}

const LINE_STYLES: Record<DiffLine['kind'], string> = {
  ctx: 'text-slate-500',
  add: 'bg-emerald-500/10 text-emerald-300',
  del: 'bg-red-500/10 text-red-300',
  hunk: 'bg-slate-800/60 text-sky-400/80',
};

/** Colorized unified diff; open by default when small, collapsed when long. */
export function DiffView({ diff, summary }: { diff: string; summary?: string }) {
  const { lines, adds, dels } = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [open, setOpen] = useState(() => lines.length <= 80);
  return (
    <div className="border-t border-dashed border-slate-800">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-slate-500 transition-colors hover:bg-slate-800/40"
      >
        <span className="font-semibold text-emerald-400">+{adds}</span>
        <span className="font-semibold text-red-400">−{dels}</span>
        {summary && <span className="truncate text-slate-600">{summary}</span>}
        <span className="ml-auto text-slate-600">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <pre className="max-h-72 overflow-auto whitespace-pre border-t border-slate-800/60 font-mono text-[11px] leading-relaxed">
          {lines.map((l, i) => (
            <div key={i} className={`px-3 ${LINE_STYLES[l.kind]}`}>
              {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : l.kind === 'hunk' ? '' : ' '}
              {l.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
