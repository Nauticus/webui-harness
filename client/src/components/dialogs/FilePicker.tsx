import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Dialog } from '@base-ui-components/react/dialog';
import { api, type FileEntry } from '../../api';

/**
 * The `@` file picker: a dialog over the composer that lists the project's
 * working directory and lets you point at a file in it.
 *
 * It has two modes, because there are two things people do when they reach for
 * a file — remember its name and remember where it lives:
 *
 *   empty filter  → a browser. The current directory, dirs first; Enter goes in,
 *                   Backspace goes up.
 *   typed filter  → a search. The whole tree, ranked by how well the path
 *                   matches, so `@comp` finds client/src/components/Composer.tsx
 *                   without anyone remembering the path.
 *
 * Both modes stay inside the project directory: the server takes a project id,
 * not a path, so there is no way to browse the rest of the machine from here.
 */
export function FilePicker({
  open,
  projectId,
  initialQuery = '',
  onPick,
  onClose,
}: {
  open: boolean;
  projectId: string;
  /** What was typed after the `@`, if anything — seeds the filter. */
  initialQuery?: string;
  /** A path relative to the project's working directory; dirs end in '/'. */
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [root, setRoot] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Restart from the project root every time the dialog opens, with whatever
  // was already typed after the @ as the starting filter.
  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setDir('');
    setActive(0);
  }, [open, initialQuery]);

  // Load on demand, with a short debounce: every keystroke would otherwise walk
  // the tree, and a fast typist would queue dozens of walks for one word.
  useEffect(() => {
    if (!open) return;
    let stale = false;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .listFiles({ projectId, q: query, dir })
        .then((res) => {
          if (stale) return;
          setEntries(res.entries);
          setRoot(res.root);
          setTruncated(res.truncated);
          setActive(0);
          setError('');
        })
        .catch((err: unknown) => {
          if (stale) return;
          setEntries([]);
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => !stale && setLoading(false));
    }, query ? 110 : 0);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [open, projectId, query, dir]);

  /** Keep the highlighted row in view while arrowing through a long list. */
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active=true]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, entries]);

  const crumbs = useMemo(() => dir.split('/').filter(Boolean), [dir]);

  const enter = useCallback((e: FileEntry) => {
    if (e.type !== 'dir') return;
    setDir(e.path);
    setQuery('');
    setActive(0);
  }, []);

  const up = useCallback(() => {
    if (query) {
      setQuery('');
      return;
    }
    setDir((d) => {
      const parts = d.split('/').filter(Boolean);
      parts.pop();
      return parts.join('/');
    });
    setActive(0);
  }, [query]);

  /** Enter: go into a directory, take a file. Tab: always take the entry. */
  const accept = useCallback(
    (e: FileEntry | undefined, into: boolean) => {
      if (!e) return;
      if (e.type === 'dir' && into) enter(e);
      else onPick(e.type === 'dir' ? `${e.path}/` : e.path);
    },
    [enter, onPick]
  );

  const move = (d: number) => entries.length > 0 && setActive((i) => (i + d + entries.length) % entries.length);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        return;
      case 'Enter':
        e.preventDefault();
        accept(entries[active], true);
        return;
      case 'Tab':
        // Tab takes the highlighted entry — picking is what the dialog is for.
        // Shift+Tab stays focus navigation, so the dialog is reachable by keyboard.
        if (e.shiftKey || e.ctrlKey) return;
        e.preventDefault();
        accept(entries[active], false);
        return;
      case 'Backspace':
        if (query === '' && dir !== '') {
          e.preventDefault();
          up();
        }
        return;
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-slate-950/70 backdrop-blur-sm" />
        <Dialog.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8">
          <Dialog.Popup
            onKeyDown={onKeyDown}
            className="flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-600 bg-slate-900 text-slate-200 shadow-2xl shadow-black/50 outline-none"
          >
            <div className="flex items-center gap-2 border-b border-slate-700 px-3 py-2 text-xs">
              <span className="shrink-0 text-slate-500">@</span>
              <input
                ref={inputRef}
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="search files in the project…"
                spellCheck={false}
                aria-label="Filter files"
                className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-slate-600"
              />
              <Dialog.Close
                aria-label="Close file picker"
                className="shrink-0 rounded-md border border-slate-700 p-1 text-slate-400 transition-colors hover:border-slate-500 hover:text-slate-200"
              >
                <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 3 9 9M9 3 3 9" strokeLinecap="round" />
                </svg>
              </Dialog.Close>
            </div>

            {/* Where the list is looking. In search mode this says so, because
                the rows then come from all over the tree, not from one folder. */}
            <div className="flex items-center gap-1 truncate border-b border-slate-800 px-3 py-1.5 font-mono text-[11px] text-slate-500">
              {query ? (
                <span>
                  searching <span className="text-slate-400">{root}</span>
                </span>
              ) : (
                <>
                  <span className="truncate">{root}</span>
                  {crumbs.map((c, i) => (
                    <span key={i} className="shrink-0">
                      /<span className="text-slate-400">{c}</span>
                    </span>
                  ))}
                </>
              )}
            </div>

            <ul ref={listRef} role="listbox" className="max-h-[45vh] min-h-[6rem] overflow-y-auto p-1">
              {!query && dir !== '' && (
                <li>
                  <button
                    onClick={up}
                    className="w-full rounded-md px-2 py-1.5 text-left font-mono text-xs text-slate-500 hover:bg-slate-800"
                  >
                    ⬆ ..
                  </button>
                </li>
              )}
              {entries.map((e, i) => {
                const slash = e.path.lastIndexOf('/');
                return (
                  <li key={e.path} role="option" aria-selected={i === active}>
                    <button
                      data-active={i === active}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => accept(e, e.type === 'dir')}
                      onDoubleClick={() => accept(e, false)}
                      className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs ${
                        i === active ? 'bg-violet-500/20' : 'hover:bg-slate-800'
                      }`}
                    >
                      {slash >= 0 && <span className="truncate text-slate-600">{e.path.slice(0, slash + 1)}</span>}
                      <span className={e.type === 'dir' ? 'text-sky-300' : 'text-slate-200'}>
                        {e.path.slice(slash + 1)}
                        {e.type === 'dir' ? '/' : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
              {loading && entries.length === 0 && <li className="px-3 py-2 text-xs text-slate-600">listing…</li>}
              {!loading && entries.length === 0 && (
                <li className="px-3 py-2 text-xs text-slate-600">
                  {error ? <span className="text-rose-400">{error}</span> : 'nothing matches'}
                </li>
              )}
            </ul>

            <div className="flex items-center gap-3 border-t border-slate-700 px-3 py-1.5 text-[10px] text-slate-600">
              <span>↑↓ move</span>
              <span>↵ {query ? 'open / pick' : 'go in'}</span>
              <span>⇥ pick</span>
              <span>⌫ up</span>
              {truncated && <span className="ml-auto text-amber-400/80">more matches — keep typing</span>}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
