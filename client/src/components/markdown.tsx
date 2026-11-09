import { Streamdown, type Components } from 'streamdown';
import { CodeBlock } from './CodeBlock';
import { Highlighted } from './Highlighted';

/**
 * The markdown renderer's component overrides, shared by everything that renders
 * model text: assistant replies and compaction summaries alike.
 *
 * Streamdown, not react-markdown, because it is built for text that arrives in
 * pieces: it splits the reply into top-level blocks, memoizes the ones that are
 * finished, and re-renders only the block still being written — so formatting is
 * live instead of appearing in one pop at the end. It also repairs incomplete
 * markdown (an unclosed `**` or a fence still waiting for its closing ```), which
 * would otherwise flash raw syntax mid-stream.
 *
 * Code and tables stay ours: the `code` override keeps the tree-sitter
 * highlighter so no shiki bundle is pulled in, and the `table` override drops
 * streamdown's scrollable wrapper. This lives in its own module because the
 * transcript's cards need it too, and importing it from `ItemView` would make
 * them import each other.
 */
export const MD_COMPONENTS: Components = {
  // Links in model output must not navigate this page away — that would tear
  // down a running turn. Open them in a new tab.
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
  // Fenced blocks are coloured by tree-sitter rather than streamdown's built-in
  // shiki path, so no shiki bundle is loaded; inline code and fences in
  // languages without a grammar render as plain monospace.
  code: ({ node: _node, className, children, ...props }) => {
    const lang = /language-([\w+#-]+)/.exec(className ?? '')?.[1];
    if (!lang) return <code className={className} {...props}>{children}</code>;
    return (
      <code className={className} {...props}>
        <Highlighted code={textOf(children)} language={lang} />
      </code>
    );
  },
  // Streamdown wraps a table in a scrollable box. A scroller inside the
  // transcript steals the wheel from the chat, so tables are rendered plain and
  // made to wrap: fixed layout plus the inherited `break-words` keeps even a
  // wide one inside the column it is in.
  table: ({ node: _node, ...props }) => <table {...props} className="w-full table-fixed" />,
};

/** The renderer hands code children as text, possibly in pieces. */
function textOf(children: unknown): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(textOf).join('');
  return '';
}
