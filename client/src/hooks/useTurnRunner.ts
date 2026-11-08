import { useCallback, useRef, useState } from 'react';
import { api, streamTurn } from '../api';
import type { Item } from '../lib/items';
import { applyEvent, settleCompaction, withStopped, initialTurnState, type TurnState } from '../lib/chatEvents';

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
  /**
   * Latest props, read at call time. `send`/`abort` are handed to the memoized
   * composer, so they must not change identity on every render — and reading
   * the session/input through a ref also rules out acting on a stale closure.
   */
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const busyRef = useRef(false);
  /** Pending animation frame of the throttled mirror, and the session it is for. */
  const frameRef = useRef<number | null>(null);
  const frameSessionRef = useRef<string | null>(null);

  /** Copy the authoritative turn state to the screen. */
  const mirror = useCallback((sessionId: string) => {
    optsRef.current.applyTurnState(turnRef.current, sessionId);
  }, []);

  /**
   * Mirror at most once per frame. A fast stream delivers dozens of deltas
   * between two paints, and every mirror is a render of the whole shell — the
   * state stays authoritative per event, only the repaint is coalesced.
   */
  const mirrorSoon = useCallback(
    (sessionId: string) => {
      if (frameRef.current !== null) return;
      if (typeof requestAnimationFrame !== 'function') return mirror(sessionId);
      frameSessionRef.current = sessionId;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const session = frameSessionRef.current;
        frameSessionRef.current = null;
        if (session) mirror(session);
      });
    },
    [mirror]
  );

  /** Drop a queued mirror; the caller is about to mirror synchronously. */
  const cancelMirror = useCallback(() => {
    if (frameRef.current !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      frameSessionRef.current = null;
    }
  }, []);

  const send = useCallback(async () => {
    const o = optsRef.current;
    const content = o.input.trim();
    const projectId = o.activeProjectId;
    if (!content || busyRef.current || !projectId) return;

    let sessionId = o.activeSessionId;
    if (!sessionId) {
      const s = await api.createSession(
        projectId,
        o.pendingModel(projectId),
        o.pendingEffort(projectId)
      );
      o.clearPendingModel(projectId);
      o.clearPendingEffort(projectId);
      await o.refreshSessions(projectId);
      sessionId = s.id;
      // Claim the turn BEFORE navigating: the route-change effect that views
      // this session must see it as in-flight, not fetch its (empty) history.
      streamedSessionIdRef.current = sessionId;
      o.onSessionCreated(s.id);
    }
    o.setInput('');
    busyRef.current = true;
    setBusy(true);
    setRunningSessionId(sessionId);
    const controller = new AbortController();
    controllerRef.current = controller;
    streamedSessionIdRef.current = sessionId;
    // Seed the live buffer with what is currently on screen (history or an
    // empty new session), then append the user item like every other block:
    // the UI matches the server's stream order.
    turnRef.current = {
      items: o.seedItems(sessionId).concat([{ kind: 'user', content }]),
      streamed: false,
      context: null,
    };
    mirror(sessionId);

    try {
      await streamTurn(sessionId, content, (ev) => {
        turnRef.current = applyEvent(turnRef.current, ev);
        mirrorSoon(sessionId);
      });
      // The session list of the project this turn belongs to (the user may
      // have moved to another project while it ran).
      await optsRef.current.refreshSessions(projectId);
    } catch (err) {
      // A user stop aborts the fetch; that is not an error (the stop marker
      // was already added by abort()).
      if (err instanceof DOMException && err.name === 'AbortError') return;
      turnRef.current = {
        ...turnRef.current,
        items: [...turnRef.current.items, { kind: 'error', message: String(err instanceof Error ? err.message : err) }],
      };
      mirror(sessionId);
    } finally {
      // Whatever is still queued lands now — the turn is over.
      cancelMirror();
      // A compaction interrupted by stop/error never gets its end event:
      // settle the running card so it doesn't pulse forever.
      turnRef.current = settleCompaction(turnRef.current);
      mirror(sessionId);
      controllerRef.current = null;
      streamedSessionIdRef.current = null;
      setRunningSessionId(null);
      busyRef.current = false;
      setBusy(false);
    }
  }, [mirror, mirrorSoon, cancelMirror]);

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
    cancelMirror();
    turnRef.current = withStopped(turnRef.current);
    if (sessionId) mirror(sessionId);
    busyRef.current = false;
    setBusy(false);
  }, [mirror, cancelMirror]);

  return { busy, runningSessionId, turnRef, streamedSessionIdRef, send, abort };
}
