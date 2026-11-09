import type { ReactNode } from 'react';
import { Dialog } from '@base-ui-components/react/dialog';

/** Corner brackets, drawn the way the other icons in the app are. */
export function ExpandIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path
        d="M1.5 4.5v-3h3M10.5 4.5v-3h-3M1.5 7.5v3h3M10.5 7.5v3h-3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The button every clipped block puts its expand icon in. */
export function ExpandButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="ml-auto shrink-0 rounded-md border border-slate-700/70 p-1 text-slate-500 transition-colors hover:border-slate-500 hover:text-slate-200"
    >
      <ExpandIcon />
    </button>
  );
}

/**
 * The surface a clipped block opens into: the same dialog the diff uses, so
 * every "show me all of it" in the app looks and behaves the same way.
 *
 * This is the one place in the transcript area that scrolls — a dialog with no
 * scrollbar could not show a ten-thousand-line result at all. It is also not
 * nested scrolling: nothing is scrolling inside the chat, the chat is covered.
 *
 * The colour is set here rather than inherited: a dialog is portaled outside the
 * shell div that tints the whole app, so anything inside it that does not name a
 * colour would render in the default black on a dark panel.
 */
export function ExpandDialog({
  open,
  onOpenChange,
  title,
  closeLabel,
  toolbar,
  widthClass = 'max-w-5xl',
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  closeLabel: string;
  toolbar?: ReactNode;
  widthClass?: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-slate-950/70 backdrop-blur-sm" />
        <Dialog.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8">
          <Dialog.Popup
            className={`flex h-full w-full flex-col overflow-hidden rounded-xl border border-slate-600 bg-slate-900 text-slate-200 shadow-2xl shadow-black/50 outline-none ${widthClass}`}
          >
            <div className="flex items-center gap-3 border-b border-slate-700 px-4 py-2.5 text-xs">
              <Dialog.Title className="min-w-0 flex-1 truncate font-mono text-slate-200">{title}</Dialog.Title>
              {toolbar}
              <Dialog.Close
                aria-label={closeLabel}
                className="shrink-0 rounded-md border border-slate-700 p-1 text-slate-400 transition-colors hover:border-slate-500 hover:text-slate-200"
              >
                <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 3 9 9M9 3 3 9" strokeLinecap="round" />
                </svg>
              </Dialog.Close>
            </div>
            {children}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
