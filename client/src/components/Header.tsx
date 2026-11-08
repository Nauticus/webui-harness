import { memo } from 'react';
import type { Project } from '../api';
import { ProjectTabs } from './ProjectTabs';

/** Memoized: the header only cares about projects and the panel flags,
 *  not about the chat streaming below it. */
export const Header = memo(function Header({
  projects,
  activeProject,
  providersOpen,
  hasDetectionFailure,
  onToggleProviders,
  onSelectProject,
  onNewProject,
  onEditProject,
}: {
  projects: Project[];
  activeProject: Project | null;
  providersOpen: boolean;
  hasDetectionFailure: boolean;
  onToggleProviders: () => void;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
  onEditProject: () => void;
}) {
  return (
    <header className="flex items-center gap-1 border-b border-slate-800 px-3 py-2">
      <button
        onClick={onToggleProviders}
        title="Providers"
        className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
          providersOpen
            ? 'bg-slate-800 text-slate-100'
            : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
        }`}
      >
        <span>🔌</span>
        {hasDetectionFailure && (
          <span
            className="h-1.5 w-1.5 rounded-full bg-amber-400"
            title="a provider failed model detection"
          />
        )}
      </button>
      <div className="mx-1 h-5 w-px shrink-0 bg-slate-800" />
      <ProjectTabs
        projects={projects}
        activeProjectId={activeProject?.id ?? null}
        onSelect={onSelectProject}
        onNew={onNewProject}
      />
      {activeProject && (
        <>
          <span className="hidden max-w-44 truncate rounded-full border border-slate-700 bg-slate-900 px-2.5 py-0.5 font-mono text-[10px] text-slate-400 sm:inline">
            {activeProject.cwd || 'default dir'}
          </span>
          <button
            onClick={onEditProject}
            title="Project settings"
            className="rounded-lg p-1.5 text-lg leading-none text-slate-500 transition-colors hover:bg-slate-800 hover:text-sky-400"
          >
            ⚙
          </button>
        </>
      )}
    </header>
  );
});
