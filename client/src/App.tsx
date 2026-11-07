import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { api, streamTurn, type DirsResponse, type MessageRow, type Session } from './api';

type Item =
  | { kind: 'user'; content: string }
  | { kind: 'assistant'; content: string }
  | { kind: 'tool'; id: string; name: string; args?: unknown; result?: string }
  | { kind: 'error'; message: string };

function rowsToItems(rows: MessageRow[]): Item[] {
  const items: Item[] = [];
  for (const r of rows) {
    let meta: { tool_calls?: unknown[]; name?: string; args?: unknown } = {};
    if (r.meta) {
      try {
        meta = JSON.parse(r.meta);
      } catch {
        meta = {};
      }
    }
    if (r.role === 'user') items.push({ kind: 'user', content: r.content });
    else if (r.role === 'assistant') {
      if (r.content) items.push({ kind: 'assistant', content: r.content });
    } else if (r.role === 'tool') {
      items.push({ kind: 'tool', id: String(r.id), name: meta.name ?? 'tool', args: meta.args, result: r.content });
    }
  }
  return items;
}

const TOOL_ICONS: Record<string, string> = {
  bash: '$',
  read_file: '📄',
  write_file: '✏️',
  list_dir: '📁',
};

function formatArgs(args: unknown): string {
  const s = typeof args === 'string' ? args : JSON.stringify(args);
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamedRef = useRef(false);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await api.listSessions());
    } catch {
      /* server not up yet */
    }
  }, []);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items, busy]);

  useEffect(() => {
    setShowSettings(false);
  }, [activeId]);

  const loadSession = useCallback(async (id: string) => {
    try {
      const { messages } = await api.getSession(id);
      setActiveId(id);
      setItems(rowsToItems(messages));
      setLoadError(null);
    } catch (err) {
      setLoadError(String(err instanceof Error ? err.message : err));
    }
  }, []);

  const newSession = useCallback(async () => {
    const s = await api.createSession();
    await refreshSessions();
    setActiveId(s.id);
    setItems([]);
    setLoadError(null);
  }, [refreshSessions]);

  const removeSession = useCallback(
    async (id: string) => {
      await api.deleteSession(id);
      if (activeId === id) {
        setActiveId(null);
        setItems([]);
      }
      await refreshSessions();
    },
    [activeId, refreshSessions]
  );

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content || busy) return;

    let sessionId = activeId;
    if (!sessionId) {
      const s = await api.createSession();
      sessionId = s.id;
      setActiveId(s.id);
      setItems([]);
    }
    setInput('');
    setBusy(true);
    streamedRef.current = false;
    setItems((prev) => [...prev, { kind: 'user', content }, { kind: 'assistant', content: '' }]);

    try {
      await streamTurn(sessionId, content, (ev) => {
        switch (ev.type) {
          case 'message.delta':
            streamedRef.current = true;
            setItems((prev) => {
              const next = [...prev];
              for (let i = next.length - 1; i >= 0; i--) {
                const it = next[i]!;
                if (it.kind === 'assistant') {
                  next[i] = { kind: 'assistant', content: it.content + String(ev.text) };
                  break;
                }
              }
              return next;
            });
            break;
          case 'tool.start':
            setItems((prev) => [
              ...prev,
              { kind: 'tool', id: String(ev.id), name: String(ev.name), args: ev.args },
            ]);
            break;
          case 'tool.result':
            setItems((prev) =>
              prev.map((it) =>
                it.kind === 'tool' && it.id === String(ev.id)
                  ? { ...it, result: String(ev.result) }
                  : it
              )
            );
            break;
          case 'message.complete':
            if (String(ev.content) && !streamedRef.current) {
              setItems((prev) => [...prev, { kind: 'assistant', content: String(ev.content) }]);
            }
            break;
          case 'error':
            setItems((prev) => [...prev, { kind: 'error', message: String(ev.message) }]);
            break;
          default:
            break;
        }
      });
      await refreshSessions();
    } catch (err) {
      setItems((prev) => [
        ...prev,
        { kind: 'error', message: String(err instanceof Error ? err.message : err) },
      ]);
    } finally {
      setBusy(false);
    }
  }, [input, busy, activeId, refreshSessions]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const active = sessions.find((s) => s.id === activeId);

  return (
    <div className="flex h-full bg-slate-950 text-slate-100">
      {/* ---------- sidebar ---------- */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-800 bg-slate-900/50">
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <span className="text-sm font-bold tracking-widest text-sky-400">weblisan</span>
          <span className="text-[10px] uppercase tracking-wider text-slate-600">local agent</span>
        </div>
        <div className="px-3 pt-1">
          <button
            onClick={() => void newSession()}
            className="w-full rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm font-medium text-sky-300 transition-colors hover:bg-sky-500/20"
          >
            + New session
          </button>
        </div>
        <nav className="mt-2 flex-1 overflow-y-auto px-3 pb-3">
          {sessions.length === 0 ? (
            <p className="px-2 py-3 text-xs text-slate-600">No sessions yet</p>
          ) : (
            <ul className="space-y-0.5">
              {sessions.map((s) => (
                <li key={s.id} className="group relative">
                  <button
                    onClick={() => void loadSession(s.id)}
                    className={`w-full rounded-lg px-3 py-2 pr-7 text-left transition-colors ${
                      s.id === activeId
                        ? 'bg-slate-800 text-slate-100'
                        : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                    }`}
                  >
                    <span className="block truncate text-sm">{s.title}</span>
                    <span className="block truncate font-mono text-[10px] text-slate-600">
                      {s.model || 'default model'}
                      {s.cwd && ` · ${s.cwd.replace(/^\/?home\/[^/]+\//, '')}`}
                    </span>
                  </button>
                  <button
                    onClick={() => void removeSession(s.id)}
                    title="Delete session"
                    className="absolute right-2 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-700 hover:text-rose-400 group-hover:flex"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
      </aside>

      {/* ---------- main ---------- */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-slate-800 px-5 py-3">
          <h1 className="truncate text-sm font-semibold">{active ? active.title : 'Weblisan'}</h1>
          {active && (
            <>
              <span className="hidden truncate rounded-full border border-slate-700 bg-slate-900 px-2.5 py-0.5 font-mono text-[10px] text-slate-400 sm:inline">
                {active.model || 'default model'}
              </span>
              <span className="hidden max-w-56 truncate rounded-full border border-slate-700 bg-slate-900 px-2.5 py-0.5 font-mono text-[10px] text-slate-400 sm:inline">
                {active.cwd || 'default dir'}
              </span>
            </>
          )}
          {active && (
            <button
              onClick={() => setShowSettings((v) => !v)}
              title="Session settings"
              className={`ml-auto rounded-lg p-1.5 text-lg leading-none transition-colors ${
                showSettings
                  ? 'bg-slate-800 text-sky-400'
                  : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
              }`}
            >
              ⚙
            </button>
          )}
        </header>

        {showSettings && active && (
          <SessionSettings
            key={active.id}
            session={active}
            onSaved={() => void refreshSessions()}
            onClose={() => setShowSettings(false)}
          />
        )}

        <div className="flex-1 overflow-y-auto px-5 py-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            {loadError && (
              <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">
                {loadError}
              </div>
            )}
            {items.length === 0 && !loadError && (
              <div className="m-auto max-w-sm text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900 text-2xl">
                  🤖
                </div>
                <p className="text-sm font-medium text-slate-300">Start a conversation</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">
                  The agent runs a real loop with shell &amp; file tools, sandboxed to the
                  session's working directory.
                </p>
              </div>
            )}
            {items.map((it, i) => (
              <ItemView key={i} item={it} isLast={i === items.length - 1} busy={busy} />
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        <footer className="border-t border-slate-800 px-5 py-4">
          <div className="mx-auto w-full max-w-3xl">
            <div className="flex items-end gap-2 rounded-2xl border border-slate-700 bg-slate-900 p-2 transition-colors focus-within:border-sky-500/60">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask the agent to do something…"
                rows={2}
                disabled={busy}
                className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-slate-600 disabled:opacity-50"
              />
              <button
                onClick={() => void send()}
                disabled={busy || !input.trim()}
                className="rounded-xl bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-400 disabled:cursor-default disabled:bg-slate-800 disabled:text-slate-500"
              >
                {busy ? '…' : 'Send'}
              </button>
            </div>
            <p className="mt-1.5 text-center text-[11px] text-slate-600">
              Enter to send · Shift+Enter for newline
            </p>
          </div>
        </footer>
      </main>
    </div>
  );
}

/* ---------- settings ---------- */

function SessionSettings({
  session,
  onSaved,
  onClose,
}: {
  session: Session;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [model, setModel] = useState(session.model);
  const [cwd, setCwd] = useState(session.cwd);
  const [models, setModels] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [browsing, setBrowsing] = useState(false);
  const [dirs, setDirs] = useState<DirsResponse | null>(null);

  useEffect(() => {
    api
      .listModels()
      .then((r) => setModels(r.models))
      .catch(() => setModels([]));
  }, []);

  const browseTo = useCallback(async (p?: string) => {
    try {
      setDirs(await api.listDirs(p));
      setBrowsing(true);
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err));
    }
  }, []);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateSession(session.id, { model, cwd: cwd.trim() });
      onSaved();
      onClose();
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err));
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    'rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-sky-500';

  return (
    <div className="flex max-h-[60%] flex-col gap-3 overflow-y-auto border-b border-slate-800 bg-slate-900/70 px-5 py-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] uppercase tracking-wider text-slate-500">Model</label>
        <input
          list="model-options"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="server default"
          spellCheck={false}
          className={inputCls}
        />
        <datalist id="model-options">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[11px] uppercase tracking-wider text-slate-500">Working dir</label>
        <div className="flex gap-2">
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="server default (workspace)"
            spellCheck={false}
            className={`${inputCls} flex-1`}
          />
          <button
            onClick={() => void browseTo(cwd.trim() || undefined)}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 transition-colors hover:border-slate-600"
          >
            Browse
          </button>
        </div>
      </div>

      {browsing && dirs && (
        <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
          <div className="truncate border-b border-slate-800 px-3 py-2 font-mono text-[11px] text-slate-500">
            {dirs.path}
          </div>
          <ul className="max-h-48 overflow-y-auto p-1">
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

      {saveError && <p className="text-xs text-rose-400">{saveError}</p>}

      <div className="flex justify-end gap-2">
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
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

/* ---------- items ---------- */

function ItemView({ item, isLast, busy }: { item: Item; isLast: boolean; busy: boolean }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="self-end">
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-sky-500/30 bg-sky-500/10 px-4 py-2.5 text-sm">
            {item.content}
          </div>
        </div>
      );
    case 'assistant':
      if (!item.content && isLast && busy) {
        return (
          <div className="self-start">
            <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-slate-800 bg-slate-900 px-4 py-3.5">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:300ms]" />
            </div>
          </div>
        );
      }
      return (
        <div className="self-start">
          <div className="prose prose-sm prose-invert max-w-none break-words rounded-2xl rounded-bl-md border border-slate-800 bg-slate-900 px-4 py-3 !text-slate-200 [&_code]:rounded [&_code]:bg-slate-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sky-300 [&_pre]:bg-slate-950 [&_pre]:text-slate-300">
            <ReactMarkdown>{item.content || ' '}</ReactMarkdown>
          </div>
        </div>
      );
    case 'tool':
      return (
        <div className="w-full max-w-[85%] self-start">
          <details className="group overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60">
            <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3 py-2 text-xs text-slate-400 [&::-webkit-details-marker]:hidden">
              <span className="w-4 text-center">{TOOL_ICONS[item.name] ?? '🔧'}</span>
              <span className="font-semibold text-emerald-400">{item.name}</span>
              {item.args !== undefined && (
                <span className="truncate font-mono text-[11px] text-slate-600">
                  {formatArgs(item.args)}
                </span>
              )}
              {!item.result ? (
                <span className="ml-auto animate-pulse text-[11px] text-sky-400">running…</span>
              ) : (
                <span className="ml-auto text-slate-600 transition-transform group-open:rotate-90">▸</span>
              )}
            </summary>
            <div className="border-t border-slate-800">
              {item.args !== undefined && (
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-slate-500">
                  {JSON.stringify(item.args, null, 2)}
                </pre>
              )}
              {item.result && (
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words border-t border-dashed border-slate-800 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
                  {item.result}
                </pre>
              )}
            </div>
          </details>
        </div>
      );
    case 'error':
      return (
        <div className="self-start">
          <div className="max-w-[85%] rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-300">
            <strong>error:</strong> {item.message}
          </div>
        </div>
      );
  }
}
