import { memo } from 'react';
import { Streamdown, type Components } from 'streamdown';
import type { Skill } from '../api';
import { type Item, isSkillFile, parseSkillInvocation, toolTarget } from '../lib/items';
import { ThinkingCard } from './ThinkingCard';
import { CodeBlock } from './CodeBlock';
import { Highlighted } from './Highlighted';
import { ToolCard } from './ToolCard';
import { CompactionCard } from './CompactionCard';
import { SkillCard, matchSkill } from './SkillCard';

/**
 * Renderer for assistant text.
 *
 * Streamdown, not react-markdown, because it is built for text that arrives in
 * pieces: it splits the reply into top-level blocks, memoizes the ones that are
 * finished, and re-renders only the block still being written — so formatting
 * is live instead of appearing in one pop at the end. It also repairs
 * incomplete markdown (an unclosed `**` or a fence still waiting for its
 * closing ```), which would otherwise flash raw syntax mid-stream.
 *
 * Static mode is used for anything already finished, which skips the streaming
 * machinery entirely and renders the text as a single unit.
 *
 * Code stays ours: the `code` override below keeps the tree-sitter highlighter,
 * so no shiki bundle is pulled in.
 */
const MD_COMPONENTS: Components = {
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
};

/** The renderer hands code children as text, possibly in pieces. */
function textOf(children: unknown): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(textOf).join('');
  return '';
}

/** Memoized: a streaming turn only ever changes the last item, and every
 *  other item keeps its identity through the reducer — so per delta exactly
 *  one ItemView renders and the rest of the transcript is skipped. */
export const ItemView = memo(function ItemView({
  item,
  skills,
  streaming = false,
  stateKey,
}: {
  item: Item;
  skills?: Skill[];
  /** Row key, handed to the collapsible cards so their open state survives
   *  being scrolled out of the virtualized window. */
  stateKey: string;
  /** Receiving deltas right now. Switches the renderer to streaming mode,
   *  where finished blocks are memoized and only the tail block is re-parsed
   *  per commit. */
  streaming?: boolean;
}) {
  switch (item.kind) {
    case 'user': {
      const invocation = parseSkillInvocation(item.content);
      return (
        // Rows are plain blocks, not flex children, so the row itself has to
        // do the aligning — align-self here would be a no-op.
        <div className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-sky-500/30 bg-sky-500/10 px-4 py-2.5 text-sm">
            {invocation ? (
              <>
                <span className="mb-1.5 inline-flex items-center gap-1.5 rounded-full border border-violet-500/40 bg-violet-500/15 px-2.5 py-0.5 text-xs font-semibold text-violet-300">
                  <span>✦</span>
                  skill: {invocation.name}
                </span>
                {invocation.task ? <span className="block">{invocation.task}</span> : null}
              </>
            ) : (
              item.content
            )}
          </div>
        </div>
      );
    }
    case 'assistant':
      return (
        <div>
          <div className="prose prose-sm prose-invert max-w-none break-words [&_code]:rounded [&_code]:bg-slate-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sky-300 [&_pre]:bg-slate-950 [&_pre]:text-slate-300 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_th]:border [&_th]:border-slate-700 [&_td]:border [&_td]:border-slate-700 [&_tr:nth-child(even)_td]:bg-slate-800/40">
            {/* Streaming mode for finished text too, deliberately. Switching an
                item to static mode when it settles throws away the block list
                and remounts every block at once: measured as a 899ms long task
                at the exact moment a reply finishes, on a 185KB reply. Left in
                streaming mode, the same settle costs 50ms. The price is on
                opening old history — ~470ms more on that same 185KB reply,
                because every block is a separate memoized render — which lands
                where a beat is expected instead of mid-conversation. */}
            <Streamdown mode="streaming" isAnimating={streaming} components={MD_COMPONENTS}>
              {item.content || ' '}
            </Streamdown>
          </div>
        </div>
      );
    case 'thinking':
      return <ThinkingCard content={item.content} done={item.done} stateKey={stateKey} />;
    case 'tool': {
      // A SKILL.md read is the visible moment a skill's instructions enter
      // the context — render it as a skill card, not a generic file read.
      if (item.name === 'read_file' && isSkillFile(toolTarget(item.name, item.args))) {
        return (
          <SkillCard
            name={item.name}
            args={item.args}
            result={item.result}
            ok={item.ok}
            skill={matchSkill(item.name, item.args, skills)}
            stateKey={stateKey}
          />
        );
      }
      return (
            <ToolCard
              name={item.name}
              args={item.args}
              result={item.result}
              ok={item.ok}
              diff={item.diff}
              stateKey={stateKey}
            />
          );
    }
    case 'compaction':
      return <CompactionCard item={item} stateKey={stateKey} />;
    case 'stopped':
      return <div className="py-0.5 text-[11px] text-slate-500">⏹ stopped</div>;
    case 'error':
      return (
        <div>
          <div className="max-w-[85%] rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-300">
            <strong>error:</strong> {item.message}
          </div>
        </div>
      );
  }
});
