import { useCallback, useState } from 'react';
import { api, type Session } from '../api';

/** Sessions of the active project + active session selection. */
export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const refreshSessions = useCallback(async (projectId: string) => {
    setSessions(await api.listSessions(projectId));
  }, []);

  const selectProject = useCallback((id: string | null) => {
    setActiveSessionId(null);
    setSessions([]);
  }, []);

  const removeSession = useCallback(
    async (id: string) => {
      await api.deleteSession(id);
      setActiveSessionId((cur) => (cur === id ? null : cur));
    },
    []
  );

  const updateSessionLocal = useCallback((id: string, model: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, model } : s)));
  }, []);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  return {
    sessions,
    activeSession,
    activeSessionId,
    setActiveSessionId,
    refreshSessions,
    selectProject,
    removeSession,
    updateSessionLocal,
  };
}
