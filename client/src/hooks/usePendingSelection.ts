import { useCallback, useState } from 'react';

/**
 * A per-project pending pick that becomes a real session patch once a
 * session exists: the composer's value is held pending until the first
 * message creates the session, then patched onto the session. Used for
 * both the model and the reasoning-effort selection.
 */
export function usePendingSelection(
  activeProjectId: string | null,
  activeSessionId: string | null,
  sessionValue: string, // '' = auto
  patchSession: (id: string, value: string) => Promise<unknown>,
  onLocalUpdate: (id: string, value: string) => void,
) {
  const [pending, setPending] = useState<Record<string, string>>({});

  /** The composer value: the session's pick, else the pending one. */
  const value =
    activeSessionId !== null ? sessionValue : pending[activeProjectId ?? ''] ?? '';

  const set = useCallback(
    async (v: string) => {
      if (activeSessionId) {
        await patchSession(activeSessionId, v);
        onLocalUpdate(activeSessionId, v);
      } else if (activeProjectId) {
        setPending((prev) => ({ ...prev, [activeProjectId!]: v }));
      }
    },
    [activeSessionId, activeProjectId, patchSession, onLocalUpdate]
  );

  const pendingFor = useCallback(
    (projectId: string) => pending[projectId] ?? '',
    [pending]
  );

  const clearPending = useCallback((projectId: string) => {
    setPending((prev) => {
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
  }, []);

  return { value, set, pendingFor, clearPending };
}
