import { useCallback, useState } from 'react';
import { api, type Project } from '../api';

/** Projects list + active project selection. Cross-feature side effects
 *  (clearing sessions/items on switch) are handled by the caller. */
export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projectsLoaded, setProjectsLoaded] = useState(false);

  const refreshProjects = useCallback(async () => {
    setProjects(await api.listProjects());
  }, []);

  const initialLoad = useCallback(async (): Promise<Project | null> => {
    try {
      const list = await api.listProjects();
      setProjects(list);
      const first = list[0] ?? null;
      if (first) setActiveProjectId(first.id);
      return first;
    } finally {
      setProjectsLoaded(true);
    }
  }, []);

  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  return {
    projects,
    setProjects,
    activeProject,
    activeProjectId,
    setActiveProjectId,
    projectsLoaded,
    refreshProjects,
    initialLoad,
  };
}
