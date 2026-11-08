import { memo, useEffect, useState, type KeyboardEvent } from 'react';
import { Select } from '@base-ui-components/react/select';
import type { ModelGroup, Skill } from '../api';
import { fmtTokens } from '../lib/context';

/**
 * Composer: full-width prompt input with a compact model-picker chip and a
 * reasoning-effort chip. Clicking the model chip opens a popover listing
 * "auto" (provider's default) followed by the provider's base models
 * (aliases/snapshots collapsed, with their context window when known);
 * the current pick gets a checkmark. The chip itself shows the selected
 * model's context window as a suffix (e.g. "gpt-4o · 128k"). The effort
 * chip offers how hard thinking-capable models should reason (auto =
 * the provider's default).
 */
const EFFORT_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: '', label: 'auto', hint: "provider's default" },
  { value: 'low', label: 'low', hint: 'quick, cheap' },
  { value: 'medium', label: 'medium', hint: 'balanced' },
  { value: 'high', label: 'high', hint: 'deep reasoning' },
  { value: 'xhigh', label: 'xhigh', hint: 'deepest' },
];

export const Composer = memo(function Composer({
  model,
  modelGroups,
  effort,
  input,
  busy,
  disabled,
  placeholder,
  onModelChange,
  onEffortChange,
  onInput,
  onKeyDown,
  onSend,
  onStop,
  skills,
  defaultModel = '',
  defaultEffort = '',
}: {
  model: string; // '' = auto (provider's default model)
  modelGroups: ModelGroup[];
  effort: string; // '' = auto (provider's default reasoning effort)
  /** Provider-level defaults, shown next to the "auto" options. */
  defaultModel?: string;
  defaultEffort?: string;
  input: string;
  busy: boolean;
  disabled: boolean;
  placeholder: string;
  onModelChange: (v: string) => void;
  onEffortChange: (v: string) => void;
  onInput: (v: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onStop: () => void;
  skills?: Skill[];
}) {
  const [acIndex, setAcIndex] = useState(0);
  /** Escape closes the menu without touching the text; it reopens as soon as
   *  the query changes. */
  const [acDismissed, setAcDismissed] = useState(false);

  // /skill: autocomplete — a single leading "/token" (no spaces yet).
  // The server expands /skill:name [task] into the skill's instructions.
  const acQuery = (() => {
    const t = input.trim();
    if (!t.startsWith('/') || /\s/.test(t)) return null;
    let q = t.slice(1);
    if (q.startsWith('skill:')) q = q.slice('skill:'.length);
    return q.toLowerCase();
  })();
  const acMatches =
    acQuery === null
      ? []
      : (skills ?? []).filter(
          (sk) => acQuery === '' || sk.name.startsWith(acQuery) || sk.name.includes(acQuery)
        );
  const acOpen = acQuery !== null && acMatches.length > 0 && !acDismissed && !disabled;
  useEffect(() => {
    setAcIndex(0);
    setAcDismissed(false);
  }, [acQuery]);
  const insertSkill = (skill: Skill) => {
    onInput(`/skill:${skill.name} `);
  };
  /** True while an IME is composing — there, Enter confirms a candidate. */
  const composing = (e: KeyboardEvent<HTMLTextAreaElement>) =>
    e.nativeEvent.isComposing || e.keyCode === 229;
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing(e)) return;
    if (acOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAcIndex((i) => (i + 1) % acMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAcIndex((i) => (i - 1 + acMatches.length) % acMatches.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const m = acMatches[acIndex] ?? acMatches[0];
        if (m) insertSkill(m);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAcDismissed(true);
        return;
      }
    }
    // While the agent works the composer stays editable and Enter adds a
    // newline instead of sending: nothing typed is lost, nothing is sent
    // into a running turn by accident.
    if (busy && e.key === 'Enter' && !e.shiftKey) return;
    onKeyDown(e);
  };

  const pickerDisabled = busy || disabled;
  // The group the current model belongs to (canonical id or one of its aliases).
  const currentGroup = modelGroups.find((g) => g.id === model || g.aliases.includes(model));

  return (
    <footer className="border-t border-slate-800 px-5 py-4">
      <div className="mx-auto w-full max-w-3xl">
        <div className="relative">
          {acOpen && (
            <div className="absolute bottom-full left-0 right-0 z-20 mb-1.5 max-h-64 overflow-auto rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-xl">
              <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-slate-600">
                Skills — Enter to insert
              </div>
              {acMatches.map((sk, i) => (
                <button
                  key={sk.name}
                  type="button"
                  onMouseEnter={() => setAcIndex(i)}
                  onClick={() => insertSkill(sk)}
                  className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left ${
                    i === acIndex ? 'bg-violet-500/20' : ''
                  }`}
                >
                  <span className="text-xs text-violet-400">✦</span>
                  <span className="shrink-0 font-mono text-xs text-slate-200">{sk.name}</span>
                  <span className="truncate text-xs text-slate-500">{sk.description}</span>
                  <span
                    className={`ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${
                      sk.source === 'project'
                        ? 'bg-sky-500/20 text-sky-300'
                        : 'bg-slate-800 text-slate-500'
                    }`}
                  >
                    {sk.source}
                  </span>
                </button>
              ))}
            </div>
          )}
        <div className="flex items-end gap-2 rounded-2xl border border-slate-700 bg-slate-900 p-2 transition-colors focus-within:border-sky-500/60">
          <textarea
            value={input}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={2}
            disabled={disabled}
            className="max-h-40 min-h-[3rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-slate-600 disabled:opacity-50"
          />
          {busy ? (
            <button
              onClick={onStop}
              title="Stop the agent (cancels the LLM call and kills any running command)"
              className="shrink-0 rounded-xl bg-rose-500/90 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
            >
              ■ Stop
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={!input.trim() || disabled}
              className="shrink-0 rounded-xl bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-400 disabled:cursor-default disabled:bg-slate-800 disabled:text-slate-500"
            >
              Send
            </button>
          )}
          </div>
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
          <Select.Root
            value={model}
            onValueChange={(v) => v !== null && onModelChange(v)}
            disabled={pickerDisabled}
            // The stored model can be an alias; its group counts as selected.
            isItemEqualToValue={(itemId, selected) => {
              if (selected === '') return itemId === '';
              if (itemId === selected) return true;
              const g = modelGroups.find((x) => x.id === itemId);
              return g ? g.aliases.includes(selected) : false;
            }}
          >
            <Select.Trigger
              title="Model for this chat"
              className={(state) =>
                `group flex items-center gap-1.5 rounded-full border bg-slate-900 px-2.5 py-1 text-[11px] transition-colors disabled:opacity-50 ${
                  state.open
                    ? 'border-sky-500/50 text-slate-200'
                    : 'border-slate-700/80 text-slate-400 hover:border-sky-500/50 hover:text-slate-200'
                }`
              }
            >
              <span className="max-w-[14rem] truncate">
                {model ? model : defaultModel ? `auto · ${defaultModel}` : 'auto'}
              </span>
              {model && currentGroup?.contextWindow !== undefined && (
                <span
                  className="shrink-0 rounded-full border border-slate-700 px-1.5 text-[10px] text-slate-500"
                  title="Context window (tokens)"
                >
                  {fmtTokens(currentGroup.contextWindow)}
                </span>
              )}
              <svg
                viewBox="0 0 12 12"
                className="h-3 w-3 transition-transform group-[aria-expanded=true]:rotate-180"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M2.5 4.5 6 8l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner side="top" align="start" sideOffset={6} className="z-20">
                <Select.Popup className="rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-xl">
                  <Select.List className="max-h-64 w-60 overflow-auto py-1">
                    <Select.Item
                      value=""
                      className="group flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-left text-xs outline-none transition-colors group-data-[highlighted]:bg-slate-800 group-data-[selected]:text-sky-400 text-slate-300"
                    >
                      <span className="text-slate-400">
                        auto — {defaultModel || "provider's default"}
                      </span>
                      <span className="hidden group-data-[selected]:inline">✓</span>
                    </Select.Item>
                    {modelGroups.map((g) => (
                      <Select.Item
                        key={g.id}
                        value={g.id}
                        title={g.aliases.length > 0 ? `Aliases: ${g.aliases.join(', ')}` : undefined}
                        className="group flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-left text-xs outline-none transition-colors group-data-[highlighted]:bg-slate-800 group-data-[selected]:text-sky-400 text-slate-300"
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate">{g.id}</span>
                          {g.aliases.length > 0 && (
                            <span
                              className="shrink-0 rounded-full border border-slate-700 px-1 text-[10px] text-slate-500"
                              title={`Aliases: ${g.aliases.join(', ')}`}
                            >
                              +{g.aliases.length}
                            </span>
                          )}
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {g.contextWindow !== undefined && (
                            <span className="text-[10px] text-slate-500">{fmtTokens(g.contextWindow)}</span>
                          )}
                          <span className="hidden group-data-[selected]:inline">✓</span>
                        </span>
                      </Select.Item>
                    ))}
                  </Select.List>
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
            <Select.Root
              value={effort}
              onValueChange={(v) => v !== null && onEffortChange(v)}
              disabled={pickerDisabled}
            >
              <Select.Trigger
                title="Reasoning effort for this chat (thinking-capable models)"
                className={(state) =>
                  `group flex items-center gap-1 rounded-full border bg-slate-900 px-2.5 py-1 text-[11px] transition-colors disabled:opacity-50 ${
                    state.open
                      ? 'border-violet-500/50 text-slate-200'
                      : 'border-slate-700/80 text-slate-400 hover:border-violet-500/50 hover:text-slate-200'
                  }`
                }
              >
                <span className="text-violet-400/80">✦</span>
                {effort ? effort : defaultEffort ? `auto · ${defaultEffort}` : 'auto'}
                <svg
                  viewBox="0 0 12 12"
                  className="h-3 w-3 transition-transform group-[aria-expanded=true]:rotate-180"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M2.5 4.5 6 8l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Select.Trigger>
              <Select.Portal>
                <Select.Positioner side="top" align="start" sideOffset={6} className="z-20">
                  <Select.Popup className="rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-xl">
                    <Select.List className="w-52 py-1">
                      {EFFORT_OPTIONS.map((o) => (
                        <Select.Item
                          key={o.value || 'auto'}
                          value={o.value}
                          className="group flex cursor-pointer items-baseline justify-between gap-2 px-3 py-1.5 text-left text-xs outline-none transition-colors group-data-[highlighted]:bg-slate-800 group-data-[selected]:text-violet-300 text-slate-300"
                        >
                          <span>{o.label}</span>
                          <span className="text-[10px] text-slate-600">
                            {o.value === '' ? defaultEffort || o.hint : o.hint}
                          </span>
                        </Select.Item>
                      ))}
                    </Select.List>
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
          </div>
          <div className="flex items-center gap-3">
            <p className="text-[11px] text-slate-600">
              {busy
                ? 'Agent is working — Enter adds a newline'
                : 'Enter to send · Shift+Enter for newline'}
              {(skills ?? []).length > 0 ? ' · / for skills' : ''}
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
});
