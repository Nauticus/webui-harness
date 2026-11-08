import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import type { Skill } from '../api';
import { type Item, isSkillFile, parseSkillInvocation, toolTarget } from '../lib/items';
import { ThinkingCard } from './ThinkingCard';
import { ToolCard } from './ToolCard';
import { CompactionCard } from './CompactionCard';
import { SkillCard, matchSkill } from './SkillCard';

/** Links in model output must not navigate this page away — that would tear
 *  down a running turn. Open them in a new tab. */
const MD_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
};

/** Memoized: a streaming turn only ever changes the last item, and every
 *  other item keeps its identity through the reducer — so per delta exactly
 *  one ItemView renders and the rest of the transcript is skipped. */
export const ItemView = memo(function ItemView({
  item,
  skills,
  streaming = false,
}: {
  item: Item;
  skills?: Skill[];
  /** Receiving deltas right now. Such text is rendered as plain wrapped text
   *  rather than markdown: re-parsing the whole growing reply on every frame
   *  is the single biggest client cost (measured: 3000 deltas of a ~200KB
   *  reply burned ~3.3s of main thread in ~40 commits ≈ 85ms each, while the
   *  same 3000 deltas of short text produced no long task at all). Plain text
   *  also avoids showing half a code fence mid-stream; markdown is parsed
   *  once, when the item settles. */
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
          {streaming ? (
            <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">
              {item.content}
            </div>
          ) : (
            <div className="prose prose-sm prose-invert max-w-none break-words [&_code]:rounded [&_code]:bg-slate-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sky-300 [&_pre]:bg-slate-950 [&_pre]:text-slate-300 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_th]:border [&_th]:border-slate-700 [&_td]:border [&_td]:border-slate-700 [&_tr:nth-child(even)_td]:bg-slate-800/40">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {item.content || ' '}
              </ReactMarkdown>
            </div>
          )}
        </div>
      );
    case 'thinking':
      return <ThinkingCard content={item.content} done={item.done} />;
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
          />
        );
      }
      return <ToolCard name={item.name} args={item.args} result={item.result} ok={item.ok} diff={item.diff} />;
    }
    case 'compaction':
      return <CompactionCard item={item} />;
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
