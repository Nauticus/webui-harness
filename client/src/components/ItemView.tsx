import { memo } from 'react';
import { Streamdown } from 'streamdown';
import type { Skill } from '../api';
import { type Item, isSkillFile, parseSkillInvocation, toolTarget } from '../lib/items';
import { ThinkingCard } from './ThinkingCard';
import { MD_COMPONENTS } from './markdown';
import { ToolCard } from './ToolCard';
import { CompactionCard } from './CompactionCard';
import { SkillCard, matchSkill } from './SkillCard';

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
          <div className="prose prose-sm prose-invert max-w-none break-words [&_code]:rounded [&_code]:bg-slate-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sky-300 [&_pre]:bg-slate-950 [&_pre]:text-slate-300 [&_table]:table [&_table]:w-full [&_table]:table-fixed [&_td]:break-words [&_th]:break-words [&_th]:border [&_th]:border-slate-700 [&_td]:border [&_td]:border-slate-700 [&_tr:nth-child(even)_td]:bg-slate-800/40">
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
              shell={item.shell}
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
