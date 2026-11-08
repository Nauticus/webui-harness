import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { api, type ContextUsage } from '../api';
import { rowsToItems, type Item } from '../lib/items';
import type { TurnState } from '../lib/chatEvents';
import { usePendingSelection } from './usePendingSelection';
import { useTurnRunner } from './useTurnRunner';

/**
 * The chat turn engine: display state (items, context, view switching)
 * composed from three parts — the turn lifecycle (useTurnRunner), the
 * per-chat model/effort selection (usePendingSelection ×2), and the
 * display mirroring below. Blocks are appended in server stream order.
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
  const [context, setContext] = useState<ContextUsage | null>(null);
  /** Last known context usage per session: live `context` events while a
   *  turn streams, the server's recomputed value on load. Survives
   *  navigation, so the bar always has something to show. */
  const contextBySessionRef = useRef(new Map<string, ContextUsage>());
  /** The session currently displayed in `items` (set by viewSession). */
  const viewSessionId = useRef<string | null>(null);
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

  const turn = useTurnRunner({
    activeProjectId: opts.activeProjectId,
    activeSessionId: opts.activeSessionId,
    input,
    setInput,
    pendingModel: model.pendingFor,
    pendingEffort: effort.pendingFor,
    clearPendingModel: model.clearPending,
    clearPendingEffort: effort.clearPending,
    // Seed the live buffer with what is currently on screen (history or an
    // empty new session); the user item is appended by the runner.
    seedItems: (sessionId) => (sessionId === viewSessionId.current ? [...itemsRef.current] : []),
    // Mirror the running turn to the display: items only when the running
    // session is on screen; the context map always (per session id).
    applyTurnState: (state: TurnState, sessionId: string) => {
      if (state.context) contextBySessionRef.current.set(sessionId, state.context);
      if (sessionId === viewSessionId.current) {
        setItems(state.items);
        if (state.context) setContext(state.context);
      }
    },
    refreshSessions: opts.refreshSessions,
    onSessionCreated: (id) => {
      setContext(null); // fresh session: no history context yet
      opts.onSessionCreated(id);
    },
  });
  const { turnRef, streamedSessionIdRef } = turn;

  /** Switch the display to a session (or the session-less project view).
   *  A session with an in-flight turn shows its live items; anything else
   *  loads from the server. The running turn is never aborted. */
  const viewSession = useCallback(
    async (sessionId: string | null) => {
      viewSessionId.current = sessionId;
      if (sessionId === null) {
        setItems([]);
        setContext(null);
        return;
      }
      if (streamedSessionIdRef.current === sessionId) {
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
    },
    [turnRef, streamedSessionIdRef]
  );

  const clear = useCallback(() => {
    setItems([]);
    setContext(null);
    streamedSessionIdRef.current = null;
  }, [streamedSessionIdRef]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void turn.send();
    }
  };

  return {
    items,
    input,
    setInput,
    busy: turn.busy,
    runningSessionId: turn.runningSessionId,
    send: turn.send,
    abort: turn.abort,
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
