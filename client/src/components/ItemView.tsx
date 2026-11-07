import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Skill } from '../api';
import { type Item, isSkillFile, parseSkillInvocation, toolTarget } from '../lib/items';
import { ThinkingCard } from './ThinkingCard';
import { ToolCard } from './ToolCard';
import { CompactionCard } from './CompactionCard';
import { SkillCard, matchSkill } from './SkillCard';

export function ItemView({
  item,
  isLast,
  busy,
  skills,
}: {
  item: Item;
  isLast: boolean;
  busy: boolean;
  skills?: Skill[];
}) {
  switch (item.kind) {
    case 'user': {
      const invocation = parseSkillInvocation(item.content);
      return (
        <div className="self-end">
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
      if (!item.content && isLast && busy) {
        return (
          <div className="self-start">
            <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-slate-800 bg-slate-900 px-4 py-3.5">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400 [animation-delay:300ms]" />
            </div>
          </div>
        );
      }
      return (
        <div className="self-start">
          <div className="prose prose-sm prose-invert max-w-none break-words rounded-2xl rounded-bl-md border border-slate-800 bg-slate-900 px-4 py-3 !text-slate-200 [&_code]:rounded [&_code]:bg-slate-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sky-300 [&_pre]:bg-slate-950 [&_pre]:text-slate-300 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_th]:border [&_th]:border-slate-700 [&_td]:border [&_td]:border-slate-700 [&_tr:nth-child(even)_td]:bg-slate-800/40">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content || ' '}</ReactMarkdown>
          </div>
        </div>
      );
    case 'thinking':
      return <ThinkingCard content={item.content} done={item.done} />;
    case 'tool': {
      // A SKILL.md read is the visible moment a skill's instructions enter
      // the context — render it as a skill card, not a generic file read.
      if (item.name === 'read_file' && isSkillFile(toolTarget(item.name, item.args))) {
        return (
          <SkillCard name={item.name} args={item.args} result={item.result} skill={matchSkill(item.name, item.args, skills)} />
        );
      }
      return <ToolCard name={item.name} args={item.args} result={item.result} diff={item.diff} />;
    }
    case 'compaction':
      return <CompactionCard item={item} />;
    case 'stopped':
      return (
        <div className="self-start py-0.5 text-[11px] text-slate-500">⏹ stopped</div>
      );
    case 'error':
      return (
        <div className="self-start">
          <div className="max-w-[85%] rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-sm text-rose-300">
            <strong>error:</strong> {item.message}
          </div>
        </div>
      );
  }
}
