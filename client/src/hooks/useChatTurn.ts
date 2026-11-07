import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { api, streamTurn } from '../api';
import { rowsToItems, type Item } from '../lib/items';

/** Current context size vs the model's window and compaction threshold. */
export interface ContextUsage {
  tokens: number;
  window: number;
  threshold: number;
}

/**
 * The chat turn engine: items state, the SSE stream loop, send(), and the
 * per-chat model selection (pending until a session exists, then a real
 * session patch). Blocks are appended in server stream order.
 */
export function useChatTurn(opts: {
  activeProjectId: string | null;
  activeSessionId: string | null;
  activeSessionModel: string; // '' = auto
  activeSessionEffort: string; // '' = auto
  refreshSessions: (projectId: string) => Promise<unknown>;
  /** called with the new session id when the first message creates one */
  onSessionCreated: (id: string) => void;
  /** update the local session row after a model/effort patch */
  onSessionModelUpdated: (sessionId: string, model: string) => void;
  onSessionEffortUpdated: (sessionId: string, effort: string) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  /** The session whose turn is currently streaming (survives navigation). */
  const [runningSessionId, setRunningSessionId] = useState<string | null>(null);
  const [context, setContext] = useState<ContextUsage | null>(null);
  const [pendingModels, setPendingModels] = useState<Record<string, string>>({});
  const [pendingEfforts, setPendingEfforts] = useState<Record<string, string>>({});
  const streamedRef = useRef(false);
  const streamedSessionId = useRef<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  /** The session currently displayed in `items` (set by viewSession). */
  const viewSessionId = useRef<string | null>(null);
  /** Authoritative in-flight items for the running turn, kept even when
   *  the user is viewing a different session. */
  const liveRef = useRef<Item[]>([]);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;

  /** Apply a mutation to the running turn's live items; mirror to `items`
   *  state only when the running session is the one on screen. */
  const applyItems = useCallback((updater: (prev: Item[]) => Item[]) => {
    liveRef.current = updater(liveRef.current);
    if (streamedSessionId.current === viewSessionId.current) {
      setItems(liveRef.current);
    }
  }, []);

  /** Switch the display to a session (or the session-less project view).
   *  A session with an in-flight turn shows its live items; anything else
   *  loads from the server. The running turn is never aborted. */
  const viewSession = useCallback(async (sessionId: string | null) => {
    viewSessionId.current = sessionId;
    if (sessionId === null) {
      setItems([]);
      setContext(null);
      return;
    }
    if (streamedSessionId.current === sessionId) {
      setItems(liveRef.current);
      return;
    }
    const { messages } = await api.getSession(sessionId);
    // The route may have moved on while fetching; only apply if still shown.
    if (viewSessionId.current === sessionId) {
      setItems(rowsToItems(messages));
    }
  }, []);

  const clear = useCallback(() => {
    setItems([]);
    setContext(null);
    streamedSessionId.current = null;
  }, []);

  const pendingModelFor = useCallback(
    (projectId: string) => pendingModels[projectId] ?? '',
    [pendingModels]
  );
  const clearPendingModel = useCallback((projectId: string) => {
    setPendingModels((prev) => {
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
  }, []);

  /** The composer select value: session's model, else the pending pick. */
  const modelValue =
    opts.activeSessionId !== null ? opts.activeSessionModel : pendingModels[opts.activeProjectId ?? ''] ?? '';

  const setModel = useCallback(
    async (v: string) => {
      if (opts.activeSessionId) {
        await api.updateSessionModel(opts.activeSessionId, v);
        opts.onSessionModelUpdated(opts.activeSessionId, v);
      } else if (opts.activeProjectId) {
        setPendingModels((prev) => ({ ...prev, [opts.activeProjectId!]: v }));
      }
    },
    [opts]
  );

  /** The composer's effort value: the session's pick, else the pending one. */
  const effortValue =
    opts.activeSessionId !== null
      ? opts.activeSessionEffort
      : pendingEfforts[opts.activeProjectId ?? ''] ?? '';

  const setEffort = useCallback(
    async (v: string) => {
      if (opts.activeSessionId) {
        await api.updateSessionReasoningEffort(opts.activeSessionId, v);
        opts.onSessionEffortUpdated(opts.activeSessionId, v);
      } else if (opts.activeProjectId) {
        setPendingEfforts((prev) => ({ ...prev, [opts.activeProjectId!]: v }));
      }
    },
    [opts]
  );

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content || busy || !opts.activeProjectId) return;

    let sessionId = opts.activeSessionId;
    if (!sessionId) {
      const s = await api.createSession(
        opts.activeProjectId,
        pendingModels[opts.activeProjectId],
        pendingEfforts[opts.activeProjectId]
      );
      setPendingModels((prev) => {
        const next = { ...prev };
        delete next[opts.activeProjectId!];
        return next;
      });
      setPendingEfforts((prev) => {
        const next = { ...prev };
        delete next[opts.activeProjectId!];
        return next;
      });
      await opts.refreshSessions(opts.activeProjectId);
      sessionId = s.id;
      // Claim the turn BEFORE navigating: the route-change effect that views
      // this session must see it as in-flight, not fetch its (empty) history.
      streamedSessionId.current = sessionId;
      opts.onSessionCreated(s.id);
      setContext(null); // fresh session: no history context yet
    }
    setInput('');
    setBusy(true);
    setRunningSessionId(sessionId);
    streamedRef.current = false;
    const controller = new AbortController();
    controllerRef.current = controller;
    streamedSessionId.current = sessionId;
    // Seed the live buffer with what is currently on screen (history or an
    // empty new session), then append the user item like every other block:
    // the UI matches the server's stream order.
    liveRef.current = sessionId === viewSessionId.current ? [...itemsRef.current] : [];
    applyItems((prev) => [...prev, { kind: 'user', content }]);

    try {
      await streamTurn(sessionId, content, (ev) => {
        switch (ev.type) {
          case 'message.delta': {
            streamedRef.current = true;
            applyItems((prev) => {
              const next = prev.map((it) =>
                it.kind === 'thinking' && !it.done ? { ...it, done: true } : it
              );
              const last = next[next.length - 1];
              if (last && last.kind === 'assistant') {
                next[next.length - 1] = { kind: 'assistant', content: last.content + String(ev.text) };
              } else {
                next.push({ kind: 'assistant', content: String(ev.text) });
              }
              return next;
            });
            break;
          }
          case 'thinking.delta':
            applyItems((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.kind === 'thinking' && !last.done) {
                next[next.length - 1] = { ...last, content: last.content + String(ev.text) };
              } else {
                next.push({ kind: 'thinking', content: String(ev.text), done: false });
              }
              return next;
            });
            break;
          case 'tool.start':
            applyItems((prev) =>
              prev.map((it) => (it.kind === 'thinking' && !it.done ? { ...it, done: true } : it))
            );
            applyItems((prev) => [
              ...prev,
              { kind: 'tool', id: String(ev.id), name: String(ev.name), args: ev.args },
            ]);
            break;
          case 'tool.result':
            applyItems((prev) =>
              prev.map((it) =>
                it.kind === 'tool' && it.id === String(ev.id)
                  ? {
                      ...it,
                      result: String(ev.result),
                      ...(typeof ev.diff === 'string' ? { diff: ev.diff } : {}),
                    }
                  : it
              )
            );
            break;
          case 'message.complete':
            applyItems((prev) =>
              prev.map((it) => (it.kind === 'thinking' && !it.done ? { ...it, done: true } : it))
            );
            if (String(ev.content) && !streamedRef.current) {
              applyItems((prev) => [...prev, { kind: 'assistant', content: String(ev.content) }]);
            }
            if (typeof ev.tokens === 'number') {
              setContext((c) => (c ? { ...c, tokens: Number(ev.tokens) } : c));
            }
            break;
          case 'message.stopped':
            // Server-side record of a stop during a non-streamed reply:
            // show the partial text plus the stopped marker.
            applyItems((prev) => {
              const next = prev.map((it) => (it.kind === 'thinking' && !it.done ? { ...it, done: true } : it));
              if (String(ev.content) && !streamedRef.current) next.push({ kind: 'assistant', content: String(ev.content) });
              next.push({ kind: 'stopped' });
              return next;
            });
            if (typeof ev.tokens === 'number') {
              setContext((c) => (c ? { ...c, tokens: Number(ev.tokens) } : c));
            }
            break;
          case 'error':
            applyItems((prev) => [...prev, { kind: 'error', message: String(ev.message) }]);
            break;
          case 'compaction.start':
            // Compaction began: the old part of the context is being summarized.
            applyItems((prev) => [
              ...prev,
              { kind: 'compaction', status: 'running', tokensBefore: Number(ev.tokensBefore) },
            ]);
            break;
          case 'compaction.progress':
            // The summarizer is still writing; live token count so far.
            applyItems((prev) => {
              for (let i = prev.length - 1; i >= 0; i--) {
                const it = prev[i]!;
                if (it.kind === 'compaction' && it.status === 'running') {
                  const next = [...prev];
                  next[i] = { ...it, tokensOut: Number(ev.tokensOut) };
                  return next;
                }
              }
              return prev;
            });
            break;
          case 'compaction':
            // Compaction finished: fill in the running item (or add a fresh
            // one if the start event was missed), with the produced summary.
            applyItems((prev) => {
              const done: Item = {
                kind: 'compaction',
                status: 'done',
                summary: String(ev.summary),
                tokensBefore: Number(ev.tokensBefore),
                tokensAfter: Number(ev.tokensAfter),
              };
              for (let i = prev.length - 1; i >= 0; i--) {
                const it = prev[i]!;
                if (it.kind === 'compaction' && it.status === 'running') {
                  const next = [...prev];
                  next[i] = { ...done, tokensOut: it.tokensOut };
                  return next;
                }
              }
              return [...prev, done];
            });
            if (typeof ev.tokensAfter === 'number') {
              setContext((c) => (c ? { ...c, tokens: Number(ev.tokensAfter) } : c));
            }
            break;
          case 'context':
            setContext({
              tokens: Number(ev.tokens),
              window: Number(ev.window),
              threshold: Number(ev.threshold),
            });
            break;
          default:
            break;
        }
      });
      await opts.refreshSessions(opts.activeProjectId);
    } catch (err) {
      // A user stop aborts the fetch; that is not an error (the stop marker
      // was already added by abort()).
      if (err instanceof DOMException && err.name === 'AbortError') return;
      applyItems((prev) => [
        ...prev,
        { kind: 'error', message: String(err instanceof Error ? err.message : err) },
      ]);
    } finally {
      // A compaction interrupted by stop/error never gets its end event:
      // settle the running card so it doesn't pulse forever.
      applyItems((prev) =>
        prev.map((it) => (it.kind === 'compaction' && it.status === 'running' ? { ...it, status: 'done' as const } : it))
      );
      controllerRef.current = null;
      streamedSessionId.current = null;
      setRunningSessionId(null);
      setBusy(false);
    }
  }, [input, busy, applyItems, opts]);

  /** Stop the running turn: aborts the local stream AND explicitly stops the
   *  server-side agent (the explicit call is what works when a dev proxy
   *  swallows the client disconnect). */
  const abort = useCallback(() => {
    if (!controllerRef.current) return;
    const sessionId = streamedSessionId.current;
    controllerRef.current.abort();
    if (sessionId) {
      fetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' }).catch(() => {});
    }
    applyItems((prev) => [...prev, { kind: 'stopped' }]);
    setBusy(false);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return {
    items,
    input,
    setInput,
    busy,
    runningSessionId,
    send,
    abort,
    context,
    modelValue,
    setModel,
    effortValue,
    setEffort,
    viewSession,
    clear,
    pendingModelFor,
    clearPendingModel,
    onKeyDown,
  };
}
