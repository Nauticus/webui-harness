import type { ReactNode } from 'react';

/** Shared shell for the header-attached panels (project dialog, providers). */
export function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="flex max-h-[65%] flex-col gap-3 overflow-y-auto border-b border-slate-800 bg-slate-900/70 px-5 py-4">
      {children}
    </div>
  );
}
