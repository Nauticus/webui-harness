import type { Skill } from '../api';
import { isSkillFile, skillDirName, toolFailed, toolTarget } from '../lib/items';
import { onToggle, usePanelOpen } from '../lib/panelState';

/** Strip leading YAML frontmatter for display (the model parsed it). */
function bodyWithoutFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

/**
 * Rendered when the model (or an explicit /skill: invocation) reads a
 * SKILL.md — the moment a skill's instructions enter the context. Violet
 * = skill, matching the composer's ✦ accent; the raw text is collapsible.
 */
export function SkillCard({
  name,
  args,
  result,
  ok,
  skill,
  stateKey,
}: {
  name: string;
  args?: unknown;
  result?: string;
  /** Explicit outcome from the server; older history falls back to the text. */
  ok?: boolean;
  skill?: Skill;
  /** Row key: keeps the reader's expand/collapse choice across virtualization. */
  stateKey: string;
}) {
  const [open, setOpen] = usePanelOpen(stateKey, false);
  const target = toolTarget(name, args);
  const dirName = skillDirName(target);
  const display = skill?.name ?? dirName;
  const isError = toolFailed({ result, ok });

  return (
    <div className="w-full max-w-[85%]">
      <div className="overflow-hidden rounded-lg border border-violet-500/50 bg-violet-950/30 shadow-md shadow-black/30">
        <div className="flex items-center gap-2 border-b border-violet-500/30 bg-violet-500/10 px-3 py-2">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-violet-500/25 text-[11px] font-bold text-violet-300">
            ✦
          </span>
          <span className="shrink-0 text-xs font-semibold text-violet-300">
            {result === undefined ? 'Loading skill…' : isError ? 'Skill load failed' : 'Skill loaded'}
          </span>
          {display && <span className="min-w-0 flex-1 truncate font-mono text-xs text-violet-200">{display}</span>}
          {skill?.source ? (
            <span className="shrink-0 rounded-full border border-violet-500/40 bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-300">
              {skill.source}
            </span>
          ) : null}
          {result !== undefined ? (
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${isError ? 'bg-rose-500/15 text-rose-300' : 'bg-emerald-500/15 text-emerald-300'}`}>
              {isError ? 'error' : 'in context'}
            </span>
          ) : (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-sky-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
              running
            </span>
          )}
        </div>

        {skill?.description && !isError ? (
          <p className="px-3 pt-2 text-xs text-slate-400">{skill.description}</p>
        ) : null}

        {result !== undefined && (
          <div className="border-t border-violet-500/20">
            {isError ? (
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-rose-300">
                {result}
              </pre>
            ) : (
              <details open={open} onToggle={onToggle(setOpen)}>
                <summary className="cursor-pointer select-none px-3 py-1.5 text-[11px] font-medium text-violet-400/80 transition-colors hover:text-violet-300">
                  instructions
                </summary>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-violet-500/20 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
                  {bodyWithoutFrontmatter(result)}
                </pre>
              </details>
            )}
          </div>
        )}

        {target && (
          <div className="border-t border-violet-500/20 px-3 py-1.5">
            <span className="block truncate font-mono text-[10px] text-slate-500" title={target}>
              {target}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Match a SKILL.md read target against a known skill (absolute or relative path). */
export function matchSkill(name: string, args: unknown, skills: Skill[] | undefined): Skill | undefined {
  if (!skills) return undefined;
  const target = toolTarget(name, args);
  if (!isSkillFile(target)) return undefined;
  const dir = skillDirName(target);
  return skills.find(
    (s) => s.filePath === target || s.dir === target.slice(0, -'SKILL.md'.length) || s.name === dir
  );
}
