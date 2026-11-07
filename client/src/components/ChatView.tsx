import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Project } from '../api';
import type { ContextUsage } from '../hooks/useChatTurn';
import type { Item } from '../lib/items';
import { ItemView } from './ItemView';
import { Onboarding } from './Onboarding';

const kfmt = (n: number) => `${Math.max(0, Math.round(n / 1000))}k`;

export function ChatView({
  items,
  busy,
  onboarding,
  activeProject,
  hasActiveSession,
  loadError,
  onCreateProject,
  context,
}: {
  items: Item[];
  busy: boolean;
  onboarding: boolean;
  activeProject: Project | null;
  hasActiveSession: boolean;
  loadError: string | null;
  onCreateProject: () => void;
  context?: ContextUsage | null;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const prevRef = useRef<{ len: number; last: Item | null }>({ len: 0, last: null });

  // Windowed rendering: only items near the viewport are mounted. Chat is
  // end-anchored (short threads hug the bottom) and new items follow the
  // viewport only while the reader is already at the end.
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 84,
    overscan: 6,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: 80,
    directDomUpdates: true,
    onChange: (instance) => setAtEnd(instance.isAtEnd()),
  });

  // Scroll contract:
  // - opening a session starts at the latest message,
  // - sending a message jumps to the latest,
  // - while pinned at the end, follow streaming growth and new items,
  // - while reading history, never yank the viewport.
  useEffect(() => {
    const prev = prevRef.current;
    const last = items[items.length - 1] ?? null;
    const loadedHistory = prev.len === 0 && items.length > 0;
    const sentMessage =
      items.length > prev.len && last?.kind === 'user' && last !== prev.last;
    if (loadedHistory || sentMessage) {
      virtualizer.scrollToEnd(sentMessage && !loadedHistory ? { behavior: 'smooth' } : undefined);
    } else if (items.length > 0 && virtualizer.isAtEnd()) {
      virtualizer.scrollToEnd();
    }
    prevRef.current = { len: items.length, last };
  }, [items, virtualizer]);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={parentRef} className="h-full overflow-y-auto">
        {loadError && (
          <div className="px-5 pt-4">
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">
              {loadError}
            </div>
          </div>
        )}

        {items.length === 0 &&
          (onboarding ? (
            <div className="flex min-h-full items-center justify-center px-5 py-6">
              <Onboarding onCreate={onCreateProject} />
            </div>
          ) : !busy ? (
            <div className="flex min-h-full items-center justify-center px-5 py-6">
              <div className="max-w-sm text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-800 bg-slate-900 text-2xl">
                  🕸
                </div>
                <h1 className="mt-4 text-lg font-semibold text-slate-100">
                  {activeProject ? 'Weblisan' : 'Create a project to start'}
                </h1>
                <p className="mt-2 text-sm leading-relaxed text-slate-400">
                  {activeProject
                    ? 'Send a message below. Weblisan works inside your project folder — it can read, write, and edit files.'
                    : 'Projects map to folders on disk. Weblisan reads and writes files inside the active project.'}
                </p>
                {!activeProject && hasActiveSession && (
                  <button
                    onClick={onCreateProject}
                    className="mt-5 rounded-xl bg-sky-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-sky-400"
                  >
                    + New project
                  </button>
                )}
              </div>
            </div>
          ) : null)}

        <div ref={virtualizer.containerRef} className="relative w-full">
          {virtualizer.getVirtualItems().map((vi) => (
            <div
              key={vi.key}
              ref={virtualizer.measureElement}
              data-index={vi.index}
              className="px-5 py-2"
              style={{ position: 'absolute', top: 0, left: 0, width: '100%' }}
            >
              <div className="mx-auto w-full max-w-3xl">
                <ItemView
                  item={items[vi.index]!}
                  isLast={vi.index === items.length - 1}
                  busy={busy}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {!atEnd && items.length > 0 && (
        <button
          onClick={() => virtualizer.scrollToEnd({ behavior: 'smooth' })}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-slate-700 bg-slate-900/90 px-3.5 py-1.5 text-[11px] text-slate-300 shadow-lg backdrop-blur transition-colors hover:border-sky-500/50 hover:text-sky-300"
        >
          ↓ latest
        </button>
      )}

      {context && context.window > 0 && (
        <div
          className="pointer-events-none absolute bottom-4 right-4 select-none rounded-full border border-slate-800 bg-slate-900/90 px-2.5 py-1 text-[11px] tabular-nums text-slate-400 shadow-lg backdrop-blur"
          title={`context: ${Math.round((context.tokens / context.window) * 100)}% used (${context.tokens.toLocaleString()} / ${context.window.toLocaleString()} tokens)`}
        >
          {kfmt(context.tokens)}/{kfmt(context.window)}
        </div>
      )}
    </div>
  );
}
