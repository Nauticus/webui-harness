import { useCallback, useState } from 'react';
import { api, type Session } from '../api';

/** Sessions of the active project. The active session is the URL's, not
 *  hook state. */
export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);

  const refreshSessions = useCallback(async (projectId: string) => {
    const list = await api.listSessions(projectId);
    setSessions(list);
    return list;
  }, []);

  /** Project switched: drop the old project's session list. */
  const selectProject = useCallback((id: string | null) => {
    if (id === null) setSessions([]);
  }, []);

  const removeSession = useCallback(async (id: string) => {
    await api.deleteSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const updateSessionLocal = useCallback(
    (id: string, patch: { model?: string; reasoningEffort?: string }) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === id
            ? {
                ...s,
                ...(patch.model !== undefined ? { model: patch.model } : {}),
                ...(patch.reasoningEffort !== undefined
                  ? { reasoning_effort: patch.reasoningEffort }
                  : {}),
              }
            : s
        )
      );
    },
    []
  );

  return {
    sessions,
    refreshSessions,
    selectProject,
    removeSession,
    updateSessionLocal,
  };
}
