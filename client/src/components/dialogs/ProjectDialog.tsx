import { useCallback, useState } from 'react';
import { api, type DirsResponse, type Project, type Provider } from '../../api';
import { Panel } from './Panel';

export type ProjectDialogState = { mode: 'create' } | { mode: 'edit'; project: Project };

const INPUT_CLS =
  'rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-sky-500';

export function ProjectDialog({
  dialog,
  providers,
  onClose,
  onCreated,
  onUpdated,
  onDeleted,
}: {
  dialog: ProjectDialogState;
  providers: Provider[];
  onClose: () => void;
  onCreated: (p: Project) => void;
  onUpdated: () => void;
  onDeleted: (id: string) => void;
}) {
  const editing = dialog.mode === 'edit' ? dialog.project : null;
  const [name, setName] = useState(editing?.name ?? '');
  const [cwd, setCwd] = useState(editing?.cwd ?? '');
  const [providerId, setProviderId] = useState(editing?.provider_id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [browsing, setBrowsing] = useState(false);
  const [dirs, setDirs] = useState<DirsResponse | null>(null);

  const defaultProviderName = providers.find((p) => p.is_default)?.name ?? 'default';

  const browseTo = useCallback(async (p?: string) => {
    try {
      setDirs(await api.listDirs(p));
      setBrowsing(true);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim() || undefined,
        cwd: cwd.trim(),
        providerId,
      };
      if (editing) {
        await api.updateProject(editing.id, payload);
        onUpdated();
      } else {
        const p = await api.createProject(payload);
        onCreated(p);
      }
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      setSaving(false);
    }
  };

  const remove = () => {
    if (!editing) return;
    if (!window.confirm(`Delete project "${editing.name}" and all of its sessions?`)) return;
    onDeleted(editing.id);
  };

  return (
    <Panel>
      <h2 className="text-sm font-semibold text-slate-200">
        {editing ? `Project: ${editing.name}` : 'New project'}
      </h2>

      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] uppercase tracking-wider text-slate-500">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={cwd.trim() ? cwd.trim().split('/').filter(Boolean).pop() : 'Project'}
          spellCheck={false}
          className={INPUT_CLS}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] uppercase tracking-wider text-slate-500">Working dir</label>
        <div className="flex gap-2">
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="server default (workspace)"
            spellCheck={false}
            className={`${INPUT_CLS} flex-1`}
          />
          <button
            onClick={() => void browseTo(cwd.trim() || undefined)}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 transition-colors hover:border-slate-600"
          >
            Browse
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] uppercase tracking-wider text-slate-500">Provider</label>
        <select
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
          className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 outline-none focus:border-sky-500"
        >
          <option value="">default ({defaultProviderName})</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.is_default ? ' ★' : ''}
            </option>
          ))}
        </select>
      </div>

      {browsing && dirs && (
        <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
          <div className="truncate border-b border-slate-800 px-3 py-2 font-mono text-[11px] text-slate-500">
            {dirs.path}
          </div>
          <ul className="max-h-44 overflow-y-auto p-1">
            {dirs.parent !== dirs.path && (
              <li>
                <button
                  onClick={() => void browseTo(dirs.parent)}
                  className="w-full rounded-md px-2 py-1.5 text-left font-mono text-xs text-slate-400 hover:bg-slate-800"
                >
                  ⬆ ..
                </button>
              </li>
            )}
            {dirs.dirs.map((d) => (
              <li key={d} className="flex items-center gap-1">
                <button
                  onClick={() => void browseTo(`${dirs.path}/${d}`)}
                  className="flex-1 truncate rounded-md px-2 py-1.5 text-left font-mono text-xs text-slate-300 hover:bg-slate-800"
                >
                  {d}/
                </button>
                <button
                  onClick={() => setCwd(`${dirs.path}/${d}`)}
                  className="rounded-md px-2 py-1.5 text-xs text-sky-400 hover:bg-slate-800"
                >
                  use
                </button>
              </li>
            ))}
            {dirs.dirs.length === 0 && dirs.parent === dirs.path && (
              <li className="px-2 py-1.5 text-xs text-slate-600">(no subdirectories)</li>
            )}
          </ul>
        </div>
      )}

      {error && <p className="text-xs text-rose-400">{error}</p>}

      <div className="flex items-center gap-2">
        {editing && (
          <button
            onClick={remove}
            className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 transition-colors hover:bg-rose-500/20"
          >
            Delete project
          </button>
        )}
        <div className="ml-auto flex gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="rounded-lg bg-sky-500 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-sky-400 disabled:opacity-50"
          >
            {saving ? 'Saving…' : editing ? 'Save' : 'Create project'}
          </button>
        </div>
      </div>
    </Panel>
  );
}
