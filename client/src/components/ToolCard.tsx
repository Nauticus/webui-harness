import { TOOL_ICONS, formatArgs } from '../lib/items';
import { DiffView } from './DiffView';

export function ToolCard({
  name,
  args,
  result,
  diff,
}: {
  name: string;
  args?: unknown;
  result?: string;
  diff?: string;
}) {
  return (
    <div className="w-full max-w-[85%] self-start">
      <details className="group overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60">
        <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3 py-2 text-xs text-slate-400 [&::-webkit-details-marker]:hidden">
          <span className="w-4 text-center">{TOOL_ICONS[name] ?? '🔧'}</span>
          <span className="font-semibold text-emerald-400">{name}</span>
          {args !== undefined && (
            <span className="truncate font-mono text-[11px] text-slate-600">{formatArgs(args)}</span>
          )}
          {!result ? (
            <span className="ml-auto animate-pulse text-[11px] text-sky-400">running…</span>
          ) : (
            <span className="ml-auto text-slate-600 transition-transform group-open:rotate-90">▸</span>
          )}
        </summary>
        <div className="border-t border-slate-800">
          {args !== undefined && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-slate-500">
              {JSON.stringify(args, null, 2)}
            </pre>
          )}
          {diff ? (
            <DiffView diff={diff} summary={result?.split('\n')[0]} />
          ) : (
            result && (
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words border-t border-dashed border-slate-800 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
                {result}
              </pre>
            )
          )}
        </div>
      </details>
    </div>
  );
}
