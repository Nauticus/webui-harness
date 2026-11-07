import { useEffect, type RefObject } from 'react';
import type { Project } from '../api';
import type { Item } from '../lib/items';
import { ItemView } from './ItemView';
import { Onboarding } from './Onboarding';

export function ChatView({
  items,
  busy,
  onboarding,
  activeProject,
  hasActiveSession,
  loadError,
  onCreateProject,
  bottomRef,
}: {
  items: Item[];
  busy: boolean;
  onboarding: boolean;
  activeProject: Project | null;
  hasActiveSession: boolean;
  loadError: string | null;
  onCreateProject: () => void;
  bottomRef: RefObject<HTMLDivElement>;
}) {
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items, busy, bottomRef]);

  return (
    <div className="flex-1 overflow-y-auto px-5 py-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        {loadError && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">
            {loadError}
          </div>
        )}

        {onboarding && <Onboarding onCreate={onCreateProject} />}

        {!onboarding && items.length === 0 && !loadError && !busy && (
          <div className="m-auto max-w-sm text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900 text-2xl">
              🤖
            </div>
            <p className="text-sm font-medium text-slate-300">
              {hasActiveSession ? 'Pick up the conversation' : 'Start a conversation'}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              The agent runs a real loop with shell &amp; file tools, sandboxed to{' '}
              <span className="font-mono text-slate-400">
                {activeProject ? activeProject.cwd || 'the server default dir' : ''}
              </span>
              .
            </p>
          </div>
        )}

        {items.map((it, i) => (
          <ItemView key={i} item={it} isLast={i === items.length - 1} busy={busy} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
