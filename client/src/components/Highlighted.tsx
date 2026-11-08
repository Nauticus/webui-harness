import { Fragment, useEffect, useState } from 'react';
import { cachedHighlight, highlight, type Segment } from '../lib/highlight';
import { TOKEN_CLASS } from '../lib/highlight-core';

/**
 * A code block, coloured by tree-sitter once its grammar is loaded.
 *
 * Until then (and forever, for languages without a grammar or when anything
 * fails) it renders the source as-is — so the text is never wrong or missing,
 * only uncoloured. Parsed blocks are cached, so a scroll or a reopened session
 * paints synchronously instead of flashing plain text.
 */
export function Highlighted({ code, language }: { code: string; language?: string }) {
  const [segments, setSegments] = useState<Segment[] | null>(() => cachedHighlight(code, language) ?? null);

  useEffect(() => {
    const cached = cachedHighlight(code, language);
    if (cached) {
      setSegments(cached);
      return;
    }
    setSegments(null);
    let alive = true;
    void highlight(code, language).then((next) => {
      if (alive && next) setSegments(next);
    });
    return () => {
      alive = false;
    };
  }, [code, language]);

  if (!segments) return <>{code}</>;
  return (
    <>
      {segments.map((s, i) =>
        s.cls ? (
          <span key={i} className={TOKEN_CLASS[s.cls]}>
            {s.text}
          </span>
        ) : (
          <Fragment key={i}>{s.text}</Fragment>
        )
      )}
    </>
  );
}
