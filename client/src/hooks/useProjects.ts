import { useCallback, useState } from 'react';
import { api, type Project } from '../api';

/** Projects list. The active project is the URL's, not hook state. */
export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);

  const refreshProjects = useCallback(async () => {
    setProjects(await api.listProjects());
  }, []);

  /** Load the project list once; returns the first project (if any). */
  const initialLoad = useCallback(async (): Promise<Project | null> => {
    try {
      const list = await api.listProjects();
      setProjects(list);
      return list[0] ?? null;
    } finally {
      setProjectsLoaded(true);
    }
  }, []);

  return {
    projects,
    setProjects,
    projectsLoaded,
    refreshProjects,
    initialLoad,
  };
}
