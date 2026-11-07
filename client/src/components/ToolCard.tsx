import { TOOL_ICONS, toolTarget } from '../lib/items';
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
  const isError = result !== undefined && result.startsWith('error');
  const target = toolTarget(name, args);
  return (
    <div className="w-full max-w-[85%] self-start">
      <details className="group overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60">
        <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3 py-2 text-xs text-slate-400 [&::-webkit-details-marker]:hidden">
          <span className="w-4 text-center">{TOOL_ICONS[name] ?? '🔧'}</span>
          <span className={`shrink-0 font-semibold ${isError ? 'text-rose-400' : 'text-emerald-400'}`}>
            {name}
          </span>
          {target && <span className="truncate font-mono text-[11px] text-slate-600">{target}</span>}
          {!result ? (
            <span className="ml-auto shrink-0 animate-pulse text-[11px] text-sky-400">running…</span>
          ) : (
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {isError && <span className="text-[11px] text-rose-400">failed</span>}
              <span className="text-slate-600 transition-transform group-open:rotate-90">▸</span>
            </span>
          )}
        </summary>
        <div className="border-t border-slate-800">
          {diff ? (
            <DiffView diff={diff} summary={result?.split('\n')[0]} />
          ) : (
            result && (
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-slate-300">
                {result}
              </pre>
            )
          )}
          {args !== undefined && (
            <details className="border-t border-dashed border-slate-800">
              <summary className="cursor-pointer select-none list-none px-3 py-1.5 text-[11px] text-slate-600 transition-colors hover:text-slate-400">
                arguments
              </summary>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-slate-500">
                {JSON.stringify(args, null, 2)}
              </pre>
            </details>
          )}
        </div>
      </details>
    </div>
  );
}
