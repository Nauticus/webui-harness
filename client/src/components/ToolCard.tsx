import { toolTarget } from '../lib/items';
import { DiffView } from './DiffView';

function StatusChip({ isError }: { isError: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-2 self-start">
      {isError ? (
        <span className="text-[11px] font-medium text-rose-400">failed</span>
      ) : (
        <span className="text-[11px] text-emerald-500">✓</span>
      )}
      <span className="text-slate-600 transition-transform group-open:rotate-90">▸</span>
    </span>
  );
}

function RunningChip() {
  return (
    <span className="flex shrink-0 items-center gap-1.5 self-start text-[11px] text-sky-400">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
      running
    </span>
  );
}

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
  const argsBlock =
    args !== undefined ? (
      <details className="border-t border-dashed border-slate-800">
        <summary className="cursor-pointer select-none list-none px-3 py-1.5 text-[11px] text-slate-600 transition-colors hover:text-slate-400">
          arguments
        </summary>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-slate-500">
          {JSON.stringify(args, null, 2)}
        </pre>
      </details>
    ) : null;

  // With a diff, the change itself is the headline: always visible, no expand needed.
  if (diff) {
    return (
      <div className="w-full max-w-[85%] self-start overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60">
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-400">
          <span className="shrink-0 font-semibold text-emerald-400">{name}</span>
          {target && <span className="break-all font-mono text-[11px] font-medium text-slate-300">{target}</span>}
        </div>
        <div className="border-t border-slate-800">
          <DiffView diff={diff} summary={result?.split('\n')[0]} />
        </div>
        {argsBlock}
      </div>
    );
  }

  // Bash gets a terminal-style card: the command IS the headline, shown in full
  // with a prompt, and the output is open by default.
  if (name === 'bash' && target) {
    return (
      <div className="w-full max-w-[85%] self-start">
        <details
          open={result !== undefined}
          className={`group overflow-hidden rounded-xl border bg-slate-900/60 transition-colors hover:border-slate-700 ${
            isError ? 'border-rose-900/70' : 'border-slate-800'
          }`}
        >
          <summary className="flex cursor-pointer select-none list-none items-start gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
            <span className="select-none font-mono text-xs text-slate-500">$</span>
            <span className="min-w-0 flex-1 break-all font-mono text-xs font-medium leading-relaxed text-slate-100">
              {target}
            </span>
            <span className="ml-auto">{result !== undefined ? <StatusChip isError={isError} /> : <RunningChip />}</span>
          </summary>
          {result && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words border-t border-slate-800 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
              {result}
            </pre>
          )}
        </details>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[85%] self-start">
      <details
        className={`group overflow-hidden rounded-xl border bg-slate-900/60 transition-colors hover:border-slate-700 ${
          isError ? 'border-rose-900/70' : 'border-slate-800'
        }`}
      >
        <summary className="flex cursor-pointer select-none list-none items-start gap-2 px-3 py-2 text-xs text-slate-400 [&::-webkit-details-marker]:hidden">
          <span className={`shrink-0 font-semibold ${isError ? 'text-rose-400' : 'text-emerald-400'}`}>
            {name}
          </span>
          {target && <span className="min-w-0 flex-1 break-all font-mono text-[11px] font-medium text-slate-300">{target}</span>}
          <span className="ml-auto">{result !== undefined ? <StatusChip isError={isError} /> : <RunningChip />}</span>
        </summary>
        <div className="border-t border-slate-800">
          {result && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-slate-300">
              {result}
            </pre>
          )}
          {argsBlock}
        </div>
      </details>
    </div>
  );
}
