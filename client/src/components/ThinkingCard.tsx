/**
 * Model reasoning, in two states:
 * - while streaming: free text, growing in the flow (no scroll panel)
 * - once complete: collapsed to a one-line header; the user expands it
 *   to read the full text (still free text, no scroll panel)
 */
export function ThinkingCard({ content, done }: { content: string; done: boolean }) {
  const chars = content.length;

  if (!done) {
    // Streaming: show the thinking as it arrives, unbounded in height.
    return (
      <div className="my-1">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-violet-300/60">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400/70" />
          thinking
        </div>
        <div className="whitespace-pre-wrap border-l border-violet-500/20 pl-3 text-sm leading-relaxed text-slate-400">
          {content}
        </div>
      </div>
    );
  }

  // Complete: collapsed by default; native <details> handles the toggle.
  return (
    <details className="group my-1">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 list-none text-[11px] font-medium uppercase tracking-wider text-violet-300/60 transition-colors hover:text-violet-300 [&::-webkit-details-marker]:hidden">
        <span className="text-[9px] transition-transform group-open:rotate-90">▶</span>
        thinking
        <span className="normal-case tabular-nums tracking-normal text-violet-400/50">
          · {chars.toLocaleString()} chars
        </span>
      </summary>
      <div className="mt-1.5 whitespace-pre-wrap border-l border-violet-500/20 pl-3 text-sm leading-relaxed text-slate-400">
        {content}
      </div>
    </details>
  );
}
