import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';

/**
 * Expanded/collapsed state that outlives the component.
 *
 * The transcript is virtualized: scroll a card out of the window and it
 * unmounts, so a `<details>` that kept its state in the DOM (or in local
 * state) came back collapsed. Keys are row keys (see `rowKey`), so a card
 * reopens exactly where the reader left it — live or after reopening the
 * session, since a tool card's key is its tool-call id.
 */
const choices = new Map<string, boolean>();
/** Bounded: a long-lived tab should not accumulate keys forever. */
const MAX_KEYS = 500;

/** The reader's explicit choice for this panel, if they made one. */
export function storedOpen(key: string): boolean | undefined {
  return choices.get(key);
}

export function setStoredOpen(key: string, open: boolean): void {
  if (!choices.has(key) && choices.size >= MAX_KEYS) {
    const oldest = choices.keys().next();
    if (!oldest.done) choices.delete(oldest.value);
  }
  choices.set(key, open);
}

/** Forget every remembered choice (tests). */
export function clearStoredOpen(): void {
  choices.clear();
}

/**
 * Controlled state for a collapsible panel: the reader's choice wins, and
 * while they have not made one the panel follows `fallback` (a tool card
 * auto-opens when its result arrives).
 */
export function usePanelOpen(key: string, fallback: boolean): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => storedOpen(key) ?? fallback);
  useEffect(() => {
    if (storedOpen(key) === undefined) setOpen(fallback);
  }, [key, fallback]);
  const set = useCallback(
    (next: boolean) => {
      setStoredOpen(key, next);
      setOpen(next);
    },
    [key]
  );
  return [open, set];
}

/** Handler for a native <details> element's toggle event. */
export function onToggle(set: (open: boolean) => void) {
  return (e: SyntheticEvent<HTMLDetailsElement>) => set(e.currentTarget.open);
}
