import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { api, streamTurn, type ContextUsage } from '../api';
import { rowsToItems, type Item } from '../lib/items';
import { applyEvent, settleCompaction, type TurnState } from '../lib/chatEvents';
import { usePendingSelection } from './usePendingSelection';

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
  /** Last known context usage per session: live `context` events while a
   *  turn streams, the server's recomputed value on load. Survives
   *  navigation, so the bar always has something to show. */
  const contextBySessionRef = useRef(new Map<string, ContextUsage>());
  const streamedSessionId = useRef<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  /** The session currently displayed in `items` (set by viewSession). */
  const viewSessionId = useRef<string | null>(null);
  /** Authoritative state of the in-flight turn (items + streamed flag +
   *  context), kept even when the user is viewing a different session. */
  const turnRef = useRef<TurnState>({ items: [], streamed: false, context: null });
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;

  // Model and effort share one selection pattern: pending until the first
  // message creates the session, then a real session patch.
  const model = usePendingSelection(
    opts.activeProjectId,
    opts.activeSessionId,
    opts.activeSessionModel,
    (id, v) => api.updateSessionModel(id, v),
    opts.onSessionModelUpdated
  );
  const effort = usePendingSelection(
    opts.activeProjectId,
    opts.activeSessionId,
    opts.activeSessionEffort,
    (id, v) => api.updateSessionReasoningEffort(id, v),
    opts.onSessionEffortUpdated
  );

  /** Mirror the running turn's items to `items` state only when the
   *  running session is the one on screen. */
  const mirrorItems = useCallback(() => {
    if (streamedSessionId.current === viewSessionId.current) {
      setItems(turnRef.current.items);
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
      setItems(turnRef.current.items);
      setContext(contextBySessionRef.current.get(sessionId) ?? null);
      return;
    }
    const { context: serverContext, messages } = await api.getSession(sessionId);
    // The route may have moved on while fetching; only apply if still shown.
    if (viewSessionId.current === sessionId) {
      setItems(rowsToItems(messages));
      if (serverContext) contextBySessionRef.current.set(sessionId, serverContext);
      setContext(serverContext ?? contextBySessionRef.current.get(sessionId) ?? null);
    }
  }, []);

  const clear = useCallback(() => {
    setItems([]);
    setContext(null);
    streamedSessionId.current = null;
  }, []);

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content || busy || !opts.activeProjectId) return;

    let sessionId = opts.activeSessionId;
    if (!sessionId) {
      const s = await api.createSession(
        opts.activeProjectId,
        model.pendingFor(opts.activeProjectId),
        effort.pendingFor(opts.activeProjectId)
      );
      model.clearPending(opts.activeProjectId);
      effort.clearPending(opts.activeProjectId);
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
    const controller = new AbortController();
    controllerRef.current = controller;
    streamedSessionId.current = sessionId;
    // Seed the live buffer with what is currently on screen (history or an
    // empty new session), then append the user item like every other block:
    // the UI matches the server's stream order.
    turnRef.current = {
      items: sessionId === viewSessionId.current ? [...itemsRef.current] : [],
      streamed: false,
      context: null,
    };
    turnRef.current = { ...turnRef.current, items: [...turnRef.current.items, { kind: 'user', content }] };
    mirrorItems();

    try {
      await streamTurn(sessionId, content, (ev) => {
        turnRef.current = applyEvent(turnRef.current, ev);
        const sid = streamedSessionId.current;
        if (sid && turnRef.current.context) {
          contextBySessionRef.current.set(sid, turnRef.current.context);
        }
        if (sid === viewSessionId.current && turnRef.current.context) {
          setContext(turnRef.current.context);
        }
        mirrorItems();
      });
      await opts.refreshSessions(opts.activeProjectId);
    } catch (err) {
      // A user stop aborts the fetch; that is not an error (the stop marker
      // was already added by abort()).
      if (err instanceof DOMException && err.name === 'AbortError') return;
      turnRef.current = {
        ...turnRef.current,
        items: [...turnRef.current.items, { kind: 'error', message: String(err instanceof Error ? err.message : err) }],
      };
      mirrorItems();
    } finally {
      // A compaction interrupted by stop/error never gets its end event:
      // settle the running card so it doesn't pulse forever.
      turnRef.current = settleCompaction(turnRef.current);
      mirrorItems();
      controllerRef.current = null;
      streamedSessionId.current = null;
      setRunningSessionId(null);
      setBusy(false);
    }
  }, [input, busy, mirrorItems, opts, model, effort]);

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
    turnRef.current = { ...turnRef.current, items: [...turnRef.current.items, { kind: 'stopped' }] };
    mirrorItems();
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
    modelValue: model.value,
    setModel: model.set,
    effortValue: effort.value,
    setEffort: effort.set,
    viewSession,
    clear,
    pendingModelFor: model.pendingFor,
    clearPendingModel: model.clearPending,
    onKeyDown,
  };
}
