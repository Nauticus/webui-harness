import { useCallback, useEffect, useState } from 'react';
import { api, type Skill } from '../api';

/**
 * Skills available to a workspace: global (~/.agents/skills) plus the
 * active project's own .agents/skills. Refreshed on demand and when the
 * project changes; the server caches discovery for 60s, so this is cheap.
 */
export function useSkills(projectId: string | null) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (pid?: string | null) => {
    setLoading(true);
    try {
      const { skills: next } = await api.listSkills(pid ?? undefined);
      setSkills(next);
    } catch {
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(projectId);
  }, [projectId, refresh]);

  return { skills, refresh, loading };
}
