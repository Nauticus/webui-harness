import { useRef, useState, type ComponentPropsWithoutRef } from 'react';

/**
 * A fenced code block with a copy button. The text is read from the DOM at
 * click time, so what is copied is exactly what is rendered — no second pass
 * over the markdown source to reassemble token children.
 */
export function CodeBlock(props: ComponentPropsWithoutRef<'pre'>) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const text = ref.current?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // no clipboard permission — stay silent rather than lie
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="group/code relative">
      <pre {...props} ref={ref} />
      <button
        onClick={() => void copy()}
        aria-label="Copy code to clipboard"
        className="absolute right-1.5 top-1.5 rounded border border-slate-700 bg-slate-900/90 px-1.5 py-0.5 text-[10px] text-slate-400 opacity-0 transition-opacity hover:text-sky-300 focus:opacity-100 group-hover/code:opacity-100"
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}
