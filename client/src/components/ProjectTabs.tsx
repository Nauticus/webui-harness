import type { Project } from '../api';

export function ProjectTabs({
  projects,
  activeProjectId,
  onSelect,
  onNew,
}: {
  projects: Project[];
  activeProjectId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      {projects.map((p) => (
        <button
          key={p.id}
          onClick={() => onSelect(p.id)}
          title={`${p.cwd || 'default dir'}`}
          className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors ${
            p.id === activeProjectId
              ? 'bg-slate-800 font-medium text-slate-100'
              : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
          }`}
        >
          <span className="max-w-40 truncate">{p.name}</span>
        </button>
      ))}
      <button
        onClick={onNew}
        title="New project"
        className="shrink-0 rounded-lg px-2.5 py-1.5 text-lg leading-none text-slate-500 transition-colors hover:bg-slate-800 hover:text-sky-400"
      >
        +
      </button>
    </div>
  );
}
