export function ThinkingCard({ content, done }: { content: string; done: boolean }) {
  return (
    <div className="w-full max-w-[85%] self-start">
      <details
        open={!done}
        className="group overflow-hidden rounded-xl border border-violet-500/20 bg-violet-500/5"
      >
        <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3 py-2 text-xs text-violet-300/80 [&::-webkit-details-marker]:hidden">
          <span>💭</span>
          <span className="font-medium">thinking</span>
          {done ? (
            <span className="ml-auto text-violet-400/50 transition-transform group-open:rotate-90">
              ▸
            </span>
          ) : (
            <span className="ml-auto animate-pulse text-violet-300">thinking…</span>
          )}
        </summary>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words border-t border-violet-500/10 p-3 font-mono text-[11px] leading-relaxed text-violet-200/70">
          {content}
        </pre>
      </details>
    </div>
  );
}
