import { useState } from 'react';
import { api, type Provider, type ProviderInput } from '../../api';
import { Panel } from './Panel';

const INPUT_CLS =
  'rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-sky-500';

export function ProvidersPanel({
  providers,
  onClose,
  onChanged,
}: {
  providers: Provider[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Provider | 'new' | null>(null);
  const [formName, setFormName] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formKey, setFormKey] = useState('');
  const [formDefault, setFormDefault] = useState(false);
  const [formContextWindows, setFormContextWindows] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState<string | null>(null);

  const openNew = () => {
    setFormName('');
    setFormUrl('');
    setFormKey('');
    setFormDefault(providers.length === 0);
    setFormContextWindows({});
    setError(null);
    setEditing('new');
  };
  const openEdit = (p: Provider) => {
    setFormName(p.name);
    setFormUrl(p.base_url);
    setFormKey(p.api_key);
    setFormDefault(p.is_default);
    setFormContextWindows(
      Object.fromEntries(
        p.model_groups.map((g) => [g.id, g.contextWindow !== undefined ? String(g.contextWindow) : ''])
      )
    );
    setError(null);
    setEditing(p);
  };

  const save = async () => {
    if (!formName.trim()) {
      setError('name is required');
      return;
    }
    for (const [id, v] of Object.entries(formContextWindows)) {
      if (v.trim() === '') continue;
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) {
        setError(`invalid context window for ${id} — positive integer tokens, or blank`);
        return;
      }
    }
    setBusy(true);
    setError(null);
    const payload: ProviderInput = {
      name: formName,
      baseUrl: formUrl,
      apiKey: formKey,
      isDefault: formDefault,
    };
    // Only send per-model context windows that actually changed. A value
    // entered on a base model is applied to all of its aliases/snapshots.
    if (editing && editing !== 'new') {
      const windows: Record<string, number | null> = {};
      for (const g of editing.model_groups) {
        const v = (formContextWindows[g.id] ?? '').trim();
        const next = v === '' ? null : Number(v);
        for (const m of editing.models) {
          if (m.id !== g.id && !g.aliases.includes(m.id)) continue;
          if ((m.contextWindow ?? null) === next) continue;
          windows[m.id] = next;
        }
      }
      if (Object.keys(windows).length > 0) payload.modelContextWindows = windows;
    }
    try {
      if (editing === 'new') await api.createProvider(payload);
      else if (editing) await api.updateProvider(editing.id, payload);
      await onChanged();
      setEditing(null);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const detect = async (id: string) => {
    setDetecting(id);
    setError(null);
    try {
      await api.detectProvider(id);
      await onChanged();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setDetecting(null);
    }
  };

  const remove = async (p: Provider) => {
    if (p.used_by > 0) return;
    if (!window.confirm(`Delete provider "${p.name}"?`)) return;
    try {
      await api.deleteProvider(p.id);
      await onChanged();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  return (
    <Panel>
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-200">Providers</h2>
        <button
          onClick={openNew}
          className="ml-auto rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-sky-400"
        >
          New provider
        </button>
        <button
          onClick={onClose}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:bg-slate-800"
        >
          Close
        </button>
      </div>

      {providers.length === 0 && (
        <p className="text-xs text-slate-500">
            No providers yet. Add one with a base URL + API key, or use the imported default.
          </p>
      )}

      <ul className="flex flex-col gap-1.5">
        {providers.map((p) => (
          <li
            key={p.id}
            className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-200">{p.name}</span>
                {p.is_default && (
                  <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-1.5 text-[9px] font-semibold uppercase tracking-wider text-sky-300">
                    default
                  </span>
                )}
              </div>
              <div className="truncate font-mono text-[10px] text-slate-500">
                {p.base_url || 'api.openai.com (official)'}
              </div>
            </div>
            <div className="w-40 shrink-0 text-right text-[11px]">
              {p.models_error ? (
                <span className="text-amber-400" title={p.models_error}>
                  ⚠ detection failed
                </span>
              ) : p.models_checked_at ? (
                <span className="text-slate-500">
                  {p.models.length} models · {p.models_checked_at.slice(11, 16)}
                </span>
              ) : (
                <span className="text-slate-600">not checked</span>
              )}
            </div>
            <button
              onClick={() => void detect(p.id)}
              disabled={detecting === p.id}
              title="Re-detect models"
              className="rounded-lg p-1.5 text-sm text-slate-400 transition-colors hover:bg-slate-800 hover:text-sky-400 disabled:opacity-50"
            >
              {detecting === p.id ? <span className="inline-block animate-spin">↻</span> : '↻'}
            </button>
            <button
              onClick={() => openEdit(p)}
              title="Edit provider"
              className="rounded-lg p-1.5 text-sm text-slate-400 transition-colors hover:bg-slate-800 hover:text-sky-400"
            >
              ⚙
            </button>
            <button
              onClick={() => void remove(p)}
              disabled={p.used_by > 0}
              title={p.used_by > 0 ? `used by ${p.used_by} project(s)` : 'Delete provider'}
              className="rounded-lg p-1.5 text-sm text-slate-400 transition-colors hover:bg-slate-800 hover:text-rose-400 disabled:cursor-default disabled:opacity-30"
            >
              🗑
            </button>
          </li>
        ))}
      </ul>

      {editing !== null && (
        <div className="flex flex-col gap-2.5 rounded-xl border border-slate-800 bg-slate-950 p-3">
          <h3 className="text-xs font-semibold text-slate-300">
            {editing === 'new' ? 'New provider' : `Edit: ${editing.name}`}
          </h3>
          <div className="grid grid-cols-2 gap-2.5">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-wider text-slate-500">Name</label>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="OpenAI"
                spellCheck={false}
                className={INPUT_CLS}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-wider text-slate-500">
                Base URL
              </label>
              <input
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                placeholder="blank = api.openai.com/v1"
                spellCheck={false}
                className={INPUT_CLS}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] uppercase tracking-wider text-slate-500">
                API key
              </label>
              <input
                type="password"
                value={formKey}
                onChange={(e) => setFormKey(e.target.value)}
                placeholder="sk-…"
                spellCheck={false}
                className={INPUT_CLS}
              />
            </div>
            <div className="flex items-end gap-2 pb-2">
              <label className="flex items-center gap-2 text-xs text-slate-400">
                <input
                  type="checkbox"
                  checked={formDefault}
                  onChange={(e) => setFormDefault(e.target.checked)}
                  className="accent-sky-500"
                />
                default provider
              </label>
            </div>
          </div>
          <p className="text-[11px] text-slate-600">
            Models are detected from the provider on save (and via ↻). A failed detection keeps
            the provider usable — type model names freely in project settings.
          </p>
          {editing !== 'new' && editing && editing.models.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] uppercase tracking-wider text-slate-500">
                Context window per model <span className="normal-case">(tokens, optional)</span>
              </label>
              <p className="-mt-1 text-[11px] text-slate-600">
                Used to decide when the chat context gets compacted. Blank = server default.
                Aliases/snapshots share their base model's value.
              </p>
              <div className="flex max-h-44 flex-col gap-1 overflow-auto rounded-lg border border-slate-800 p-2">
                {editing.model_groups.map((g) => (
                  <div key={g.id} className="flex items-center gap-2">
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-300"
                      title={g.aliases.length > 0 ? `Aliases: ${g.aliases.join(', ')}` : undefined}
                    >
                      {g.id}
                      {g.aliases.length > 0 && <span className="text-slate-600"> +{g.aliases.length}</span>}
                    </span>
                    <input
                      value={formContextWindows[g.id] ?? ''}
                      onChange={(e) => setFormContextWindows((prev) => ({ ...prev, [g.id]: e.target.value }))}
                      placeholder="e.g. 128000"
                      inputMode="numeric"
                      spellCheck={false}
                      className="w-28 shrink-0 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-right font-mono text-[11px] text-slate-200 outline-none placeholder:text-slate-600 focus:border-sky-500"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
          {error && <p className="text-xs text-rose-400">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(null)}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={busy}
              className="rounded-lg bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-sky-400 disabled:opacity-50"
            >
              {busy ? 'Saving + detecting…' : 'Save provider'}
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}
