import { useState, type ReactNode } from 'react';
import { clipText, OUTPUT_BUDGET } from '../lib/clip';
import { ExpandButton, ExpandDialog } from './Expand';

/**
 * A block of tool output that truncates instead of scrolling.
 *
 * The chat view is the app's only scroll container: a card with its own
 * scrollbar both steals the wheel from the transcript and hides most of its
 * content behind a 240px window nobody can drag with any precision. So a card
 * shows the lines that fit, says how many it left out, and opens the rest in
 * the same dialog a diff expands into.
 *
 * `render` colours a chunk of text and is applied to both the card and the
 * dialog, so the colours a reader sees are the colours they were already
 * looking at. `full` replaces the dialog body outright — used where the
 * coloured form is derived from the value rather than the clipped text, such as
 * a JSON result, which would not survive being cut mid-key.
 */
export function OutputBlock({
  text,
  title,
  lead,
  heading,
  render,
  full,
  budget = OUTPUT_BUDGET,
  className = '',
}: {
  text: string;
  title: string;
  /** Rendered before the text, not counted against it: a tool's own annotation. */
  lead?: ReactNode;
  /** Rendered above the output in the dialog: what produced this output. */
  heading?: ReactNode;
  render?: (text: string) => ReactNode;
  full?: ReactNode;
  budget?: typeof OUTPUT_BUDGET;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const clip = clipText(text, budget);
  const body = render ? render(clip.shown) : clip.shown;

  return (
    <div>
      <pre className={`whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed ${className}`}>
        {lead}
        {body}
      </pre>
      {clip.clipped && (
        <div className="flex items-center gap-2 border-t border-slate-800/60 px-3 py-1.5 text-[11px] text-slate-600">
          <span>{clip.hidden > 0 ? `${clip.hidden} more ${clip.hidden === 1 ? 'line' : 'lines'}` : 'truncated'}</span>
          <ExpandButton onClick={() => setOpen(true)} label={`Open the full ${title}`} />
        </div>
      )}
      <ExpandDialog open={open} onOpenChange={setOpen} title={title} closeLabel={`Close ${title}`}>
        {heading && (
          <div className="shrink-0 border-b border-slate-800 bg-slate-950/60 px-4 py-2.5 font-mono text-xs leading-relaxed text-slate-300">
            {heading}
          </div>
        )}
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed">
          {full ?? (render ? render(text) : text)}
        </pre>
      </ExpandDialog>
    </div>
  );
}
