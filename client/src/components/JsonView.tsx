import { Fragment, type ReactNode } from 'react';

const KEY = 'text-sky-300';
const STRING = 'text-emerald-300';
const NUMBER = 'text-amber-300';
const LITERAL = 'text-violet-400';
const PUNCT = 'text-slate-500';

/**
 * A value rendered as JSON, coloured by structure.
 *
 * There is no JSON grammar in the tree-sitter package, and none is needed: this
 * renders the value itself, so the output is exact by construction — no parser,
 * no regex, nothing to get wrong about a string that contains a quote.
 * Layout matches `JSON.stringify(value, null, 2)`.
 */
export function JsonView({ value }: { value: unknown }) {
  return <>{renderValue(value, 0)}</>;
}

function renderValue(value: unknown, indent: number): ReactNode {
  if (value === null) return <span className={LITERAL}>null</span>;
  if (typeof value === 'string') return <span className={STRING}>{JSON.stringify(value)}</span>;
  if (typeof value === 'number' || typeof value === 'bigint') return <span className={NUMBER}>{String(value)}</span>;
  if (typeof value === 'boolean') return <span className={LITERAL}>{String(value)}</span>;
  if (value === undefined) return null;

  const pad = ' '.repeat(indent + 2);
  const close = ' '.repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className={PUNCT}>{'[]'}</span>;
    return (
      <>
        <span className={PUNCT}>[</span>
        {value.map((v, i) => (
          <div key={i}>
            {pad}
            {renderValue(v, indent + 2)}
            {i < value.length - 1 ? <span className={PUNCT}>,</span> : null}
          </div>
        ))}
        {close}
        <span className={PUNCT}>]</span>
      </>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return <span className={PUNCT}>{'{}'}</span>;
  return (
    <>
      <span className={PUNCT}>{'{'}</span>
      {entries.map(([k, v], i) => (
        <div key={k}>
          {pad}
          <span className={KEY}>{JSON.stringify(k)}</span>
          <span className={PUNCT}>: </span>
          <Fragment>{renderValue(v, indent + 2)}</Fragment>
          {i < entries.length - 1 ? <span className={PUNCT}>,</span> : null}
        </div>
      ))}
      {close}
      <span className={PUNCT}>{'}'}</span>
    </>
  );
}
