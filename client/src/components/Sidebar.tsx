import type { Project, Session } from '../api';

export function Sidebar({
  sessions,
  activeProject,
  activeSessionId,
  onNewSession,
  onSelect,
  onRemove,
}: {
  sessions: Session[];
  activeProject: Project | null;
  activeSessionId: string | null;
  onNewSession: () => void;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-slate-800 bg-slate-900/50">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <span className="text-sm font-bold tracking-widest text-sky-400">weblisan</span>
        <span className="text-[10px] uppercase tracking-wider text-slate-600">local agent</span>
      </div>
      <div className="px-3 pt-1">
        <button
          onClick={onNewSession}
          disabled={!activeProject}
          className="w-full rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm font-medium text-sky-300 transition-colors hover:bg-sky-500/20 disabled:cursor-default disabled:opacity-40"
        >
          + New session
        </button>
      </div>
      <nav className="mt-2 flex-1 overflow-y-auto px-3 pb-3">
        {activeProject && sessions.length === 0 ? (
          <p className="px-2 py-3 text-xs text-slate-600">
            No sessions in <span className="text-slate-400">{activeProject.name}</span> yet
          </p>
        ) : (
          <ul className="space-y-0.5">
            {sessions.map((s) => (
              <li key={s.id} className="group relative">
                <button
                  onClick={() => onSelect(s.id)}
                  className={`w-full rounded-lg px-3 py-2 pr-7 text-left transition-colors ${
                    s.id === activeSessionId
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
                  }`}
                >
                  <span className="block truncate text-sm">{s.title}</span>
                  <span className="block truncate text-[10px] text-slate-600">{s.created_at}</span>
                </button>
                <button
                  onClick={() => onRemove(s.id)}
                  title="Delete session"
                  className="absolute right-2 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-700 hover:text-rose-400 group-hover:flex"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </aside>
  );
}
