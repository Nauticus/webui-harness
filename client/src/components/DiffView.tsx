import { useEffect, useMemo, useState } from 'react';
import { highlightLines } from '../lib/highlight';
import { languageFromPath, TOKEN_CLASS, type Segment } from '../lib/highlight-core';
import { parseUnifiedDiff, pathFromDiff, splitRows, type Cell, type DiffLine } from '../lib/diff';
import { ExpandButton, ExpandDialog } from './Expand';

/** What a parsed diff needs to be painted: the rows and the tokens they map to. */
type Paint = { lines: DiffLine[]; post?: Segment[][]; pre?: Segment[][] };

/**
 * Split or unified, remembered across dialogs. The transcript is virtualized, so
 * a dialog that closed and reopened while the reader scrolled would otherwise
 * forget their choice — the same reason `panelState.ts` exists. One app-wide
 * choice, held in the module, no storage involved.
 */
let splitChoice = false;

/**
 * Diff rows a card shows before it hands the rest to the dialog. A card has no
 * scrollbar — the chat view is the app's only one — so a long change is
 * truncated and counted, exactly like a long tool result.
 */
const CARD_LINES = 18;

const MARK = { ctx: ' ', add: '+', del: '−' } as const;

const LINE_STYLES: Record<DiffLine['kind'], string> = {
  ctx: 'text-slate-600',
  add: 'bg-emerald-500/10 text-emerald-300',
  del: 'bg-rose-500/10 text-rose-300',
  hunk: 'text-sky-400/80',
};

/** The side a cell stands on decides which file line number its gutter shows. */
const CELL_STYLES: Record<Cell['kind'], string> = {
  ctx: 'text-slate-600',
  add: 'bg-emerald-500/10 text-emerald-300',
  del: 'bg-rose-500/10 text-rose-300',
  blank: 'bg-slate-800/40',
};

/** The coloured runs for one line, or the line itself when nothing parsed. */
function tokens(segs: Segment[] | undefined, text: string) {
  return segs?.length ? (
    segs.map((seg, i) =>
      seg.cls ? (
        <span key={i} className={TOKEN_CLASS[seg.cls]}>
          {seg.text}
        </span>
      ) : (
        seg.text
      )
    )
  ) : (
    text
  );
}

/** Tokens for a diff row: the deleted side reads the pre-image, the rest the post. */
function segsFor(line: DiffLine | undefined, paint: Paint): Segment[] | undefined {
  if (!line) return undefined;
  return line.kind === 'del' ? paint.pre?.[line.preAt!] : paint.post?.[line.postAt!];
}

/** One row: a hunk header, or source with its +/- gutter. */
function Row({ line, paint }: { line: DiffLine; paint: Paint }) {
  if (line.kind === 'hunk') return <div className={`px-3 py-0.5 ${LINE_STYLES.hunk}`}>{line.text}</div>;
  return (
    <div className={`flex ${LINE_STYLES[line.kind]}`}>
      <span className="w-5 shrink-0 select-none text-center opacity-60">{MARK[line.kind]}</span>
      <span className="whitespace-pre-wrap break-words">{tokens(segsFor(line, paint), line.text)}</span>
    </div>
  );
}

/** Every row of the diff, one line per row, in whatever box asks for it.
 * Scrolling is the caller's: the card clips and never scrolls, the dialog does. */
function UnifiedRows({ paint, className }: { paint: Paint; className: string }) {
  return (
    <div className={`font-mono leading-relaxed ${className}`}>
      {paint.lines.map((line, i) => (
        <Row key={i} line={line} paint={paint} />
      ))}
    </div>
  );
}

function CellView({ cell, side, paint, divider }: { cell: Cell; side: 'left' | 'right'; paint: Paint; divider?: boolean }) {
  const ln = cell.line ? (side === 'left' ? cell.line.pre : cell.line.post) : undefined;
  return (
    <div className={`flex min-w-0 ${CELL_STYLES[cell.kind]}${divider ? ' border-l border-slate-700/60' : ''}`}>
      <span className="w-11 shrink-0 select-none border-r border-slate-800/60 px-1.5 text-right text-[10px] tabular-nums opacity-60">
        {ln ?? ''}
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words px-2">{tokens(segsFor(cell.line, paint), cell.line?.text ?? '')}</span>
    </div>
  );
}

/** The same rows as two columns: before on the left, after on the right. */
function SplitRows({ paint, className }: { paint: Paint; className: string }) {
  const rows = useMemo(() => splitRows(paint.lines), [paint.lines]);
  return (
    <div className={`font-mono leading-relaxed ${className}`}>
      {rows.map((row, i) =>
        row.kind === 'hunk' ? (
          <div key={i} className={`px-3 py-0.5 ${LINE_STYLES.hunk}`}>
            {row.text}
          </div>
        ) : (
          <div key={i} className="grid grid-cols-2">
            <CellView cell={row.left} side="left" paint={paint} />
            <CellView cell={row.right} side="right" paint={paint} divider />
          </div>
        )
      )}
    </div>
  );
}

function LayoutToggle({ split, onChange }: { split: boolean; onChange: (split: boolean) => void }) {
  const cls = (on: boolean) =>
    `px-2 py-0.5 text-[10px] transition-colors ${on ? 'bg-slate-700 text-slate-100' : 'text-slate-500 hover:text-slate-300'}`;
  return (
    <div className="flex shrink-0 overflow-hidden rounded-md border border-slate-700" role="group" aria-label="Diff layout">
      <button aria-pressed={!split} onClick={() => onChange(false)} className={cls(!split)}>
        inline
      </button>
      <button aria-pressed={split} onClick={() => onChange(true)} className={cls(split)}>
        split
      </button>
    </div>
  );
}

/**
 * The diff at reading size. It is the same rows and the same tokens as the card
 * shows — nothing is re-parsed — just a surface that is wider, taller and a
 * point larger, with the file it belongs to in the title. Split puts the two
 * sides of the change next to each other, which needs the room: the dialog grows
 * to take it.
 */
function DiffModal({
  open,
  paint,
  path,
  adds,
  dels,
  onOpenChange,
}: {
  open: boolean;
  paint: Paint;
  path: string;
  adds: number;
  dels: number;
  onOpenChange: (open: boolean) => void;
}) {
  const [split, setSplit] = useState(splitChoice);
  // Every dialog reads the choice when it opens, not only when it mounted: the
  // cards are on screen long before the reader ever picks a layout.
  useEffect(() => {
    if (open) setSplit(splitChoice);
  }, [open]);
  const choose = (next: boolean) => {
    splitChoice = next;
    setSplit(next);
  };
  const Rows = split ? SplitRows : UnifiedRows;

  return (
    <ExpandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={path || 'Changes'}
      closeLabel="Close the diff"
      widthClass={split ? 'max-w-[1600px]' : 'max-w-5xl'}
      toolbar={
        <>
          <span className="shrink-0 font-semibold text-emerald-400">+{adds}</span>
          <span className="shrink-0 font-semibold text-rose-400">−{dels}</span>
          <LayoutToggle split={split} onChange={choose} />
        </>
      }
    >
      <Rows paint={paint} className="min-h-0 flex-1 overflow-auto py-2 text-xs" />
    </ExpandDialog>
  );
}

/**
 * The diff at reading size, and the whole of it: every line, in a surface wider
 * and taller than the card, with the file it belongs to in the title. The card
 * shows the first `CARD_LINES` of the same rows and counts the rest — it has no
 * scrollbar, because the chat view has the app's only one. Split puts the two
 * sides of the change next to each other, which needs the room: the dialog grows
 * to take it. Lines are coloured as source, not just tinted green and red;
 * unknown file types, and everything until the parse lands, render as plain text.
 */
export function DiffView({ diff, summary, path }: { diff: string; summary?: string; path?: string }) {
  const { lines, adds, dels, post, pre } = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const file = path || pathFromDiff(diff);
  const language = languageFromPath(file);
  const [images, setImages] = useState<{ post?: Segment[][]; pre?: Segment[][] }>({});
  const [full, setFull] = useState(false);

  useEffect(() => {
    setImages({});
    if (!language) return;
    let alive = true;
    void (async () => {
      const [postSegs, preSegs] = await Promise.all([highlightLines(post, language), highlightLines(pre, language)]);
      if (alive) setImages({ post: postSegs ?? undefined, pre: preSegs ?? undefined });
    })();
    return () => {
      alive = false;
    };
  }, [post, pre, language]);

  const paint: Paint = { lines, post: images.post, pre: images.pre };
  // Truncating the rows only ever drops the tail, so every index a token was
  // painted against still points at the same line.
  const hidden = Math.max(0, lines.length - CARD_LINES);
  const card: Paint = hidden > 0 ? { ...paint, lines: lines.slice(0, CARD_LINES) } : paint;

  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
        <span className="font-semibold text-emerald-400">+{adds}</span>
        <span className="font-semibold text-rose-400">−{dels}</span>
        {summary && <span className="truncate text-slate-600">{summary}</span>}
        <ExpandButton onClick={() => setFull(true)} label="Open the full diff" />
      </div>
      {/* The card stays inline: two columns at a chat row's width are unreadable. */}
      <UnifiedRows paint={card} className="border-t border-slate-800/60 text-[11px]" />
      {hidden > 0 && (
        <div className="border-t border-slate-800/60 px-3 py-1.5 text-[11px] text-slate-600">
          {hidden} more {hidden === 1 ? 'line' : 'lines'} — open the diff to read them
        </div>
      )}
      <DiffModal open={full} paint={paint} path={file} adds={adds} dels={dels} onOpenChange={setFull} />
    </div>
  );
}
