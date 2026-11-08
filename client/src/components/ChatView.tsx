import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Project, Skill } from '../api';
import type { ContextUsage } from '../api';
import { contextUsage } from '../lib/context';
import { toRows, rowKey, type ChatRow, type Item } from '../lib/items';
import { ItemView } from './ItemView';
import { Onboarding } from './Onboarding';


/** The "the model is working" row: shown while a turn runs but nothing on
 *  screen is visibly growing (see `toRows`). */
function BusyRow() {
  return (
    <div>
      <div className="flex w-fit items-center gap-1.5 rounded-2xl rounded-bl-md border border-slate-800 bg-slate-900 px-4 py-3.5">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:300ms]" />
      </div>
    </div>
  );
}

export function ChatView({
  items,
  busy,
  sessionId,
  onboarding,
  activeProject,
  hasActiveSession,
  loadError,
  onCreateProject,
  context,
  skills,
}: {
  items: Item[];
  busy: boolean;
  /** The session on screen; a change means "start at the latest item". */
  sessionId: string | null;
  onboarding: boolean;
  activeProject: Project | null;
  hasActiveSession: boolean;
  loadError: string | null;
  onCreateProject: () => void;
  context?: ContextUsage | null;
  skills?: Skill[];
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  /** Only re-render on a scroll that actually crosses the end boundary — a
   *  setState per scroll event would undo directDomUpdates. */
  const atEndRef = useRef(true);
  /** The rows actually rendered: the items, plus the busy placeholder. */
  const rows: ChatRow[] = useMemo(() => toRows(items, busy), [items, busy]);
  /** One readout drives the chip's label, tooltip and colour. */
  const usage = context ? contextUsage(context) : null;
  /** Deltas always append to the last item, so that is the one rendering live
   *  (see ItemView's `streaming`). When a placeholder row is appended it is
   *  the last row instead, and no item is streaming. */
  const streamingIndex = busy ? rows.length - 1 : -1;
  const prevRef = useRef<{ items: Item[]; session: string | null }>({ items: [], session: null });
  /** A session change whose items have not landed yet — jump when they do. */
  const pendingJumpRef = useRef(true);

  // Windowed rendering: only items near the viewport are mounted. Chat is
  // end-anchored (short threads hug the bottom) and new items follow the
  // viewport only while the reader is already at the end.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 84,
    overscan: 6,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: 80,
    directDomUpdates: true,
    getItemKey: (index) => rowKey(rows[index]!, index),
    onChange: (instance) => {
      const end = instance.isAtEnd();
      if (end === atEndRef.current) return;
      atEndRef.current = end;
      setAtEnd(end);
    },
  });

  // Scroll contract:
  // - opening a session starts at its latest item,
  // - sending a message jumps to the latest,
  // - while pinned at the end, follow streaming growth and new items,
  // - while reading history, never yank the viewport.
  useEffect(() => {
    const prev = prevRef.current;
    const switched = prev.session !== sessionId;
    const changed = items !== prev.items;
    prevRef.current = { items, session: sessionId };

    // The route can move to a session before its items arrive: arm the jump
    // on the switch and spend it on the first non-empty render of that
    // session, instead of guessing a switch from item counts.
    if (switched) {
      pendingJumpRef.current = true;
      // A different transcript is a different set of rows: drop the measured
      // heights of the previous one instead of laying the new rows over them.
      virtualizer.measure();
    }
    if (!changed) return;

    if (pendingJumpRef.current) {
      if (items.length === 0) return; // nothing to anchor to yet
      pendingJumpRef.current = false;
      virtualizer.scrollToEnd();
      return;
    }
    const last = items[items.length - 1] ?? null;
    const prevLast = prev.items[prev.items.length - 1] ?? null;
    const sentMessage =
      items.length > prev.items.length && last?.kind === 'user' && last !== prevLast;
    if (sentMessage) {
      virtualizer.scrollToEnd({ behavior: 'smooth' });
    } else if (items.length > 0 && virtualizer.isAtEnd()) {
      virtualizer.scrollToEnd();
    }
  }, [items, sessionId, virtualizer]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={parentRef}
        className="h-full overflow-y-auto"
        // A log, not a chat console: polite, so new items are announced — but
        // muted while a turn streams, because announcing every token would bury
        // everything else.
        role="log"
        aria-label="Conversation"
        aria-live={busy ? 'off' : 'polite'}
        aria-busy={busy}
      >
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
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index]!;
            return (
              <div
                key={vi.key}
                ref={virtualizer.measureElement}
                data-index={vi.index}
                className="px-5 py-2"
                style={{ position: 'absolute', top: 0, left: 0, width: '100%' }}
              >
                <div className="mx-auto w-full max-w-3xl">
                  {row.kind === 'busy' ? (
                    <BusyRow />
                  ) : (
                    <ItemView
                      item={row}
                      skills={skills}
                      streaming={vi.index === streamingIndex}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {!atEnd && rows.length > 0 && (
        <button
          onClick={() => virtualizer.scrollToEnd({ behavior: 'smooth' })}
          aria-label="Jump to the latest message"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-slate-700 bg-slate-900/90 px-3.5 py-1.5 text-[11px] text-slate-300 shadow-lg backdrop-blur transition-colors hover:border-sky-500/50 hover:text-sky-300"
        >
          ↓ latest
        </button>
      )}

      {/* The log is muted while streaming, so say the state out loud here. */}
      <div className="sr-only" role="status">
        {busy ? 'Assistant is responding' : ''}
      </div>

      {usage?.visible && (
        <div
          data-testid="context-chip"
          className={`pointer-events-none absolute bottom-4 right-4 select-none rounded-full border bg-slate-900/90 px-2.5 py-1 text-[11px] tabular-nums shadow-lg backdrop-blur ${
            usage.armed ? 'border-amber-500/40 text-amber-300' : 'border-slate-800 text-slate-400'
          }`}
          title={usage.title}
        >
          {usage.label}
        </div>
      )}
    </div>
  );
}
