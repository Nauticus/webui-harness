import { toolFailed, toolTarget } from '../lib/items';
import { onToggle, usePanelOpen } from '../lib/panelState';
import { Highlighted, HighlightedFile } from './Highlighted';
import { asJson, looksLikeDiff } from '../lib/toolOutput';
import { DiffView } from './DiffView';
import { JsonView } from './JsonView';
import { OutputBlock } from './OutputBlock';
import { OUTPUT_BUDGET } from '../lib/clip';

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
  ok,
  diff,
  shell,
  stateKey,
}: {
  name: string;
  args?: unknown;
  result?: string;
  /** Explicit outcome from the server; older history falls back to the text. */
  ok?: boolean;
  diff?: string;
  /** The shell that ran it, when the tool knows: colours the command line. */
  shell?: 'bash' | 'powershell';
  /** Row key: keeps the reader's expand/collapse choice across virtualization. */
  stateKey: string;
}) {
  const isError = toolFailed({ result, ok });
  // The server runs commands in one shell and says which; bash is only the
  // fallback for history written before it started saying.
  const commandLanguage = shell === 'powershell' ? 'powershell' : 'bash';
  // Open while the result is arriving, but never overrule a manual collapse.
  const [open, setOpen] = usePanelOpen(stateKey, result !== undefined);
  const target = toolTarget(name, args);
  // A read_file result IS source code, so it is coloured by that file's
  // grammar. The "[lines 4-103 of 512] " prefix is the tool's own annotation,
  // not part of the file: it is rendered plain so the parser sees only source.
  const annotation = name === 'read_file' && result && !isError ? /^\[lines [\d-]+ of \d+\] /.exec(result)?.[0] : undefined;
  const body = annotation ? result!.slice(annotation.length) : result;
  // Only read_file returns file *contents*; other tools return status lines,
  // which must not be coloured as if they were source.
  const sourcePath = name === 'read_file' && !isError ? target : '';
  // Command output that happens to be a diff or a JSON document is a lot more
  // readable rendered as one; anything else stays the raw terminal text.
  const outputJson = result !== undefined && !isError ? asJson(result) : undefined;
  // A JSON result is shown pretty-printed either way; the coloured view is the
  // dialog's, since colouring a value that has been cut mid-key is not a thing
  // that can be done honestly.
  const outputText = outputJson === undefined ? result : JSON.stringify(outputJson, null, 2);
  const argsBlock =
    args !== undefined ? (
      <details className="border-t border-dashed border-slate-700">
        <summary className="cursor-pointer select-none list-none px-3 py-1.5 text-[11px] text-slate-600 transition-colors hover:text-slate-400">
          arguments
        </summary>
        <OutputBlock
          text={JSON.stringify(args, null, 2)}
          title="arguments"
          full={<JsonView value={args} />}
          budget={{ lines: 10, chars: OUTPUT_BUDGET.chars }}
          className="text-slate-500"
        />
      </details>
    ) : null;

  // With a diff, the change itself is the headline: always visible, no expand needed.
  if (diff) {
    return (
      <div className="w-full max-w-[85%] overflow-hidden rounded-lg border border-slate-600/80 bg-slate-900 shadow-md shadow-black/30">
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-300">
          <span className="shrink-0 font-semibold text-emerald-400">{name}</span>
          {target && <span className="break-all font-mono text-[11px] font-medium text-slate-300">{target}</span>}
        </div>
        <div className="border-t border-slate-700">
          <DiffView diff={diff} summary={result?.split('\n')[0]} path={target} />
        </div>
        {argsBlock}
      </div>
    );
  }

  // Bash gets a terminal-style card: the command IS the headline, shown in full
  // with a prompt, and the output is open by default.
  if (name === 'bash' && target) {
    return (
      <div className="w-full max-w-[85%]">
        <details
          open={open}
          onToggle={onToggle(setOpen)}
          className={`group overflow-hidden rounded-lg border shadow-md shadow-black/30 transition-colors hover:border-slate-500 ${
            isError ? 'border-rose-700 bg-slate-900' : 'border-slate-600/80 bg-slate-900'
          }`}
        >
          <summary className="flex cursor-pointer select-none list-none items-start gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
            <span className="select-none font-mono text-xs font-bold text-emerald-500">$</span>
            <span className="min-w-0 flex-1 break-all font-mono text-xs font-medium leading-relaxed text-slate-100">
              <Highlighted code={target} language={commandLanguage} />
            </span>
            <span className="ml-auto">{result !== undefined ? <StatusChip isError={isError} /> : <RunningChip />}</span>
          </summary>
          {result &&
            (looksLikeDiff(result) ? (
              <div className="border-t border-slate-700">
                <DiffView diff={result} />
              </div>
            ) : (
              <OutputBlock
                text={outputText ?? ''}
                title="command output"
                heading={
                  <>
                    <span className="mr-2 select-none font-bold text-emerald-500">$</span>
                    <Highlighted code={target} language={commandLanguage} />
                  </>
                }
                full={outputJson === undefined ? undefined : <JsonView value={outputJson} />}
                className="border-t border-slate-700 text-slate-300"
              />
            ))}
        </details>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[85%]">
      <details
        open={open}
        onToggle={onToggle(setOpen)}
        className={`group overflow-hidden rounded-lg border shadow-md shadow-black/30 transition-colors hover:border-slate-500 ${
          isError ? 'border-rose-700 bg-slate-900' : 'border-slate-600/80 bg-slate-900'
        }`}
      >
        <summary className="flex cursor-pointer select-none list-none items-start gap-2 px-3 py-2 text-xs text-slate-400 [&::-webkit-details-marker]:hidden">
          <span className={`shrink-0 font-semibold ${isError ? 'text-rose-400' : 'text-emerald-400'}`}>
            {name}
          </span>
          {target && <span className="min-w-0 flex-1 break-all font-mono text-[11px] font-medium text-slate-300">{target}</span>}
          <span className="ml-auto">{result !== undefined ? <StatusChip isError={isError} /> : <RunningChip />}</span>
        </summary>
        <div className="border-t border-slate-700">
          {result && (
            <OutputBlock
              text={body ?? ''}
              title={`${name} output`}
              lead={annotation && <span className="text-slate-600">{annotation}</span>}
              render={(t) => <HighlightedFile text={t} path={sourcePath} />}
              className="text-slate-300"
            />
          )}
          {argsBlock}
        </div>
      </details>
    </div>
  );
}
