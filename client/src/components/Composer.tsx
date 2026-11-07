import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ModelGroup } from '../api';

/** 128000 -> '128k', 1000000 -> '1M'. */
export function formatContextWindow(tokens: number): string {
  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1000)}k`;
}

/**
 * Composer: full-width prompt input with a compact model-picker chip.
 * Clicking the chip opens a popover listing "auto" (provider's default)
 * followed by the provider's base models (aliases/snapshots collapsed,
 * with their context window when known); the current pick gets a checkmark.
 * The chip itself shows the selected model's context window as a suffix
 * (e.g. "gpt-4o · 128k").
 */
export function Composer({
  model,
  modelGroups,
  input,
  busy,
  disabled,
  placeholder,
  onModelChange,
  onInput,
  onKeyDown,
  onSend,
}: {
  model: string; // '' = auto (provider's default model)
  modelGroups: ModelGroup[];
  input: string;
  busy: boolean;
  disabled: boolean;
  placeholder: string;
  onModelChange: (v: string) => void;
  onInput: (v: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
}) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close the popover on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: globalThis.PointerEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDownDoc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDownDoc);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDownDoc);
    };
  }, [open]);

  const pickerDisabled = busy || disabled;
  // The group the current model belongs to (canonical id or one of its aliases).
  const currentGroup = modelGroups.find((g) => g.id === model || g.aliases.includes(model));
  // The options list is exactly: auto first, then the provider's base models.
  const options: (string | { group: ModelGroup })[] = [
    '',
    ...modelGroups.map((g) => ({ group: g })),
  ];

  return (
    <footer className="border-t border-slate-800 px-5 py-4">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex items-end gap-2 rounded-2xl border border-slate-700 bg-slate-900 p-2 transition-colors focus-within:border-sky-500/60">
          <textarea
            value={input}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            rows={2}
            disabled={busy || disabled}
            className="max-h-40 min-h-[3rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-slate-600 disabled:opacity-50"
          />
          <button
            onClick={onSend}
            disabled={busy || !input.trim() || disabled}
            className="shrink-0 rounded-xl bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-400 disabled:cursor-default disabled:bg-slate-800 disabled:text-slate-500"
          >
            {busy ? '…' : 'Send'}
          </button>
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-3">
          <div ref={pickerRef} className="relative">
            <button
              onClick={() => setOpen((v) => !v)}
              disabled={pickerDisabled}
              title="Model for this chat"
              aria-haspopup="listbox"
              aria-expanded={open}
              className="flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-900 px-2.5 py-1 text-[11px] text-slate-400 transition-colors hover:border-sky-500/50 hover:text-slate-200 disabled:opacity-50"
            >
              <span className="max-w-[14rem] truncate">{model || 'auto'}</span>
              {model && currentGroup?.contextWindow !== undefined && (
                <span
                  className="shrink-0 rounded-full border border-slate-700 px-1.5 text-[10px] text-slate-500"
                  title="Context window (tokens)"
                >
                  {formatContextWindow(currentGroup.contextWindow)}
                </span>
              )}
              <svg
                viewBox="0 0 12 12"
                className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M2.5 4.5 6 8l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {open && (
              <div
                role="listbox"
                className="absolute bottom-full left-0 z-10 mb-1.5 max-h-64 w-60 overflow-auto rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-xl"
              >
                {options.map((o) => {
                  const group = typeof o === 'string' ? undefined : o.group;
                  const id = group ? group.id : '';
                  const selected = group ? group.id === model || group.aliases.includes(model) : model === '';
                  return (
                    <button
                      key={id || 'auto'}
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        onModelChange(id); // selecting a group sends its canonical id
                        setOpen(false);
                      }}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-slate-800 ${
                        selected ? 'text-sky-400' : 'text-slate-300'
                      }`}
                      title={group && group.aliases.length > 0 ? `Aliases: ${group.aliases.join(', ')}` : undefined}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">
                          {id || <span className="text-slate-400">auto — provider's default</span>}
                        </span>
                        {group && group.aliases.length > 0 && (
                          <span
                            className="shrink-0 rounded-full border border-slate-700 px-1 text-[10px] text-slate-500"
                            title={`Aliases: ${group.aliases.join(', ')}`}
                          >
                            +{group.aliases.length}
                          </span>
                        )}
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {group?.contextWindow !== undefined && (
                          <span className="text-[10px] text-slate-500">
                            {formatContextWindow(group.contextWindow)}
                          </span>
                        )}
                        {selected && <span>✓</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <p className="text-[11px] text-slate-600">Enter to send · Shift+Enter for newline</p>
        </div>
      </div>
    </footer>
  );
}
