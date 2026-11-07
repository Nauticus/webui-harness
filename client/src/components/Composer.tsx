import type { KeyboardEvent } from 'react';

export function Composer({
  model,
  models,
  input,
  busy,
  disabled,
  placeholder,
  onModelChange,
  onInput,
  onKeyDown,
  onSend,
}: {
  model: string;
  models: string[];
  input: string;
  busy: boolean;
  disabled: boolean;
  placeholder: string;
  onModelChange: (v: string) => void;
  onInput: (v: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
}) {
  return (
    <footer className="border-t border-slate-800 px-5 py-4">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex items-end gap-2 rounded-2xl border border-slate-700 bg-slate-900 p-2 transition-colors focus-within:border-sky-500/60">
          <select
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={busy || disabled}
            title="Model for this chat"
            className="h-9 w-44 max-w-[40%] shrink-0 cursor-pointer truncate rounded-xl border border-slate-700 bg-slate-950 px-2 text-xs text-slate-300 outline-none disabled:opacity-50"
          >
            <option value="">auto</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <textarea
            value={input}
            onChange={(e) => onInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            rows={2}
            disabled={busy || disabled}
            className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-slate-600 disabled:opacity-50"
          />
          <button
            onClick={onSend}
            disabled={busy || !input.trim() || disabled}
            className="rounded-xl bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-400 disabled:cursor-default disabled:bg-slate-800 disabled:text-slate-500"
          >
            {busy ? '…' : 'Send'}
          </button>
        </div>
        <p className="mt-1.5 text-center text-[11px] text-slate-600">
          Enter to send · Shift+Enter for newline · model: auto = provider's first model
        </p>
      </div>
    </footer>
  );
}
