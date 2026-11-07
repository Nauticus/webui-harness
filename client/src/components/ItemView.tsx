import ReactMarkdown from 'react-markdown';
import type { Item } from '../lib/items';
import { ThinkingCard } from './ThinkingCard';
import { ToolCard } from './ToolCard';

export function ItemView({ item, isLast, busy }: { item: Item; isLast: boolean; busy: boolean }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="self-end">
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-sky-500/30 bg-sky-500/10 px-4 py-2.5 text-sm">
            {item.content}
          </div>
        </div>
      );
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
          <div className="prose prose-sm prose-invert max-w-none break-words rounded-2xl rounded-bl-md border border-slate-800 bg-slate-900 px-4 py-3 !text-slate-200 [&_code]:rounded [&_code]:bg-slate-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sky-300 [&_pre]:bg-slate-950 [&_pre]:text-slate-300">
            <ReactMarkdown>{item.content || ' '}</ReactMarkdown>
          </div>
        </div>
      );
    case 'thinking':
      return <ThinkingCard content={item.content} done={item.done} />;
    case 'tool':
      return <ToolCard name={item.name} args={item.args} result={item.result} />;
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
