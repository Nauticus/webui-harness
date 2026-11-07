import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
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
      // assistant rows that only carry tool_calls are represented by the tool items
    } else if (r.role === 'tool') {
      items.push({ kind: 'tool', id: String(r.id), name: meta.name ?? 'tool', args: meta.args, result: r.content });
    }
  }
  return items;
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

  // Close settings when switching away from a session
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
          case 'tool.round':
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
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="logo">weblisan</span>
          <button className="btn new" onClick={() => void newSession()}>
            + New
          </button>
        </div>
        <ul className="sessions">
          {sessions.map((s) => (
            <li key={s.id} className={s.id === activeId ? 'active' : ''}>
              <button className="session-title" onClick={() => void loadSession(s.id)} title={s.title}>
                {s.title}
              </button>
              <button
                className="session-del"
                onClick={() => void removeSession(s.id)}
                title="Delete session"
              >
                ×
              </button>
            </li>
          ))}
          {sessions.length === 0 && <li className="empty">No sessions yet</li>}
        </ul>
      </aside>

      <main className="main">
        <header className="main-head">
          <h1>{active ? active.title : 'Weblisan'}</h1>
          {active && (
            <span className="subtitle">
              {active.model || 'default model'} · {active.cwd || 'default dir'}
            </span>
          )}
          {active && (
            <button className="btn gear" onClick={() => setShowSettings((v) => !v)} title="Session settings">
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

        <div className="messages">
          {loadError && <div className="msg error">{loadError}</div>}
          {items.length === 0 && !loadError && (
            <div className="placeholder">
              <p>Start a conversation.</p>
              <p className="dim">
                The agent has shell + file tools sandboxed to <code>server/workspace/</code>.
              </p>
            </div>
          )}
          {items.map((it, i) => (
            <ItemView key={i} item={it} isLast={i === items.length - 1} busy={busy} />
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask the agent to do something…  (Enter to send, Shift+Enter for newline)"
            rows={2}
            disabled={busy}
          />
          <button className="btn send" onClick={() => void send()} disabled={busy || !input.trim()}>
            {busy ? 'Running…' : 'Send'}
          </button>
        </div>
      </main>
    </div>
  );
}

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

  return (
    <div className="settings">
      <div className="settings-row">
        <label>Model</label>
        <input
          list="model-options"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="server default"
          spellCheck={false}
        />
        <datalist id="model-options">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>

      <div className="settings-row">
        <label>Working dir</label>
        <div className="cwd-row">
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="server default (workspace)"
            spellCheck={false}
          />
          <button className="btn" onClick={() => void browseTo(cwd.trim() || undefined)}>
            Browse
          </button>
        </div>
      </div>

      {browsing && dirs && (
        <div className="dir-browser">
          <div className="dir-current">{dirs.path}</div>
          <ul>
            {dirs.parent !== dirs.path && (
              <li>
                <button onClick={() => void browseTo(dirs.parent)}>
                  ⬆ ..
                </button>
              </li>
            )}
            {dirs.dirs.map((d) => (
              <li key={d}>
                <button onClick={() => void browseTo(`${dirs.path}/${d}`)}>
                  {d}/
                </button>
                <button className="dir-use" onClick={() => setCwd(`${dirs.path}/${d}`)}>
                  use
                </button>
              </li>
            ))}
            {dirs.dirs.length === 0 && dirs.parent === dirs.path && (
              <li className="empty">(no subdirectories)</li>
            )}
          </ul>
        </div>
      )}

      {saveError && <div className="settings-error">{saveError}</div>}

      <div className="settings-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn send" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function ItemView({ item, isLast, busy }: { item: Item; isLast: boolean; busy: boolean }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg user">
          <div className="bubble">{item.content}</div>
        </div>
      );
    case 'assistant':
      if (!item.content && isLast && busy) {
        return (
          <div className="msg assistant">
            <div className="bubble thinking">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          </div>
        );
      }
      return (
        <div className="msg assistant">
          <div className="bubble">{item.content || ' '}</div>
        </div>
      );
    case 'tool':
      return (
        <div className="tool">
          <details open={false}>
            <summary>
              <span className="tool-name">{item.name}</span>
              {item.args !== undefined && (
                <span className="tool-args">{formatArgs(item.args)}</span>
              )}
              {!item.result && <span className="tool-running">running…</span>}
            </summary>
            {item.args !== undefined && <pre className="tool-detail">{JSON.stringify(item.args, null, 2)}</pre>}
            {item.result && <pre className="tool-detail tool-result">{item.result}</pre>}
          </details>
        </div>
      );
    case 'error':
      return (
        <div className="msg error">
          <strong>error:</strong> {item.message}
        </div>
      );
  }
}

function formatArgs(args: unknown): string {
  const s = typeof args === 'string' ? args : JSON.stringify(args);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}
