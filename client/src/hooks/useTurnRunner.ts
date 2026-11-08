import { useCallback, useRef, useState } from 'react';
import { api, streamTurn } from '../api';
import type { Item } from '../lib/items';
import { applyEvent, settleCompaction, initialTurnState, type TurnState } from '../lib/chatEvents';

/**
 * The turn lifecycle: send() (session creation, live-buffer seeding, SSE
 * stream consumption) and abort(). Owns the authoritative turn state —
 * it survives navigation, so a running turn keeps streaming while the
 * user views another session — and the AbortController. Display
 * mirroring (items + context) is delegated to the parent via
 * `applyTurnState`, which decides visibility.
 */
export function useTurnRunner(opts: {
  activeProjectId: string | null;
  activeSessionId: string | null;
  input: string;
  setInput: (v: string) => void;
  /** Pending picks for the project, consumed when the first message creates the session. */
  pendingModel: (projectId: string) => string;
  pendingEffort: (projectId: string) => string;
  clearPendingModel: (projectId: string) => void;
  clearPendingEffort: (projectId: string) => void;
  /** Seed items for the running turn: what is on screen, or empty for a new session. */
  seedItems: (sessionId: string) => Item[];
  /** Mirror the running turn's state to the display (parent decides visibility). */
  applyTurnState: (state: TurnState, sessionId: string) => void;
  refreshSessions: (projectId: string) => Promise<unknown>;
  /** Called with the new session id when the first message creates one. */
  onSessionCreated: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  /** The session whose turn is currently streaming (survives navigation). */
  const [runningSessionId, setRunningSessionId] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const streamedSessionIdRef = useRef<string | null>(null);
  /** Authoritative state of the in-flight turn (items + streamed flag +
   *  context), kept even when the user is viewing a different session. */
  const turnRef = useRef<TurnState>(initialTurnState());

  const send = useCallback(async () => {
    const content = opts.input.trim();
    if (!content || busy || !opts.activeProjectId) return;

    let sessionId = opts.activeSessionId;
    if (!sessionId) {
      const s = await api.createSession(
        opts.activeProjectId,
        opts.pendingModel(opts.activeProjectId),
        opts.pendingEffort(opts.activeProjectId)
      );
      opts.clearPendingModel(opts.activeProjectId);
      opts.clearPendingEffort(opts.activeProjectId);
      await opts.refreshSessions(opts.activeProjectId);
      sessionId = s.id;
      // Claim the turn BEFORE navigating: the route-change effect that views
      // this session must see it as in-flight, not fetch its (empty) history.
      streamedSessionIdRef.current = sessionId;
      opts.onSessionCreated(s.id);
    }
    opts.setInput('');
    setBusy(true);
    setRunningSessionId(sessionId);
    const controller = new AbortController();
    controllerRef.current = controller;
    streamedSessionIdRef.current = sessionId;
    // Seed the live buffer with what is currently on screen (history or an
    // empty new session), then append the user item like every other block:
    // the UI matches the server's stream order.
    turnRef.current = { items: opts.seedItems(sessionId), streamed: false, context: null };
    turnRef.current = { ...turnRef.current, items: [...turnRef.current.items, { kind: 'user', content }] };
    opts.applyTurnState(turnRef.current, sessionId);

    try {
      await streamTurn(sessionId, content, (ev) => {
        turnRef.current = applyEvent(turnRef.current, ev);
        opts.applyTurnState(turnRef.current, sessionId);
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
      opts.applyTurnState(turnRef.current, sessionId);
    } finally {
      // A compaction interrupted by stop/error never gets its end event:
      // settle the running card so it doesn't pulse forever.
      turnRef.current = settleCompaction(turnRef.current);
      opts.applyTurnState(turnRef.current, sessionId);
      controllerRef.current = null;
      streamedSessionIdRef.current = null;
      setRunningSessionId(null);
      setBusy(false);
    }
  }, [opts, busy]);

  /** Stop the running turn: aborts the local stream AND explicitly stops the
   *  server-side agent (the explicit call is what works when a dev proxy
   *  swallows the client disconnect). */
  const abort = useCallback(() => {
    if (!controllerRef.current) return;
    const sessionId = streamedSessionIdRef.current;
    controllerRef.current.abort();
    if (sessionId) {
      fetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' }).catch(() => {});
    }
    turnRef.current = { ...turnRef.current, items: [...turnRef.current.items, { kind: 'stopped' }] };
    if (sessionId) opts.applyTurnState(turnRef.current, sessionId);
    setBusy(false);
  }, [opts]);

  return { busy, runningSessionId, turnRef, streamedSessionIdRef, send, abort };
}
