# Client performance notes

Measured, not guessed. Method and numbers below, so a future change can be
compared against them.

## How this was measured

A local OpenAI-compatible SSE server (`MOCK_DELTAS`/`MOCK_GAP`/`MOCK_CHUNK`)
was registered as a provider, so a real turn ran through the real agent loop
and the real `/api/turns` stream — no external API, no tokens. A headless page
then measured, per turn:

- `wall` — send to turn end
- `long*` — `PerformanceObserver({entryTypes:['longtask']})`: count, total and
  worst blocked main-thread time
- `frames` — `requestAnimationFrame` ticks (smoothness)
- `mutations` — `MutationObserver` batches on the transcript (proxy for React
  commits)

A/B was done by stashing the working tree and re-running the same harness.

## Results

3000 deltas, ~195 KB of streamed text, sent as fast as the socket carries them:

| variant                            | wall  | long tasks | main thread blocked | frames |
| ---------------------------------- | ----- | ---------- | ------------------- | ------ |
| before                             | 4486ms | 18        | 3543ms              | 40     |
| + rAF coalescing, memo, reducer    | 3961ms | 19        | 3347ms              | 45     |
| + no markdown while streaming      | 1508ms | **0**      | **0ms**             | 92     |

Realistic cadence (400 deltas, one every 4ms) before → after:
`wall 1847 → 1819ms`, `blocked 205 → 154ms`, mutation batches `79 → 66`.

## What the numbers say

1. **Re-parsing the growing reply with ReactMarkdown on every commit is the
   cost.** Same 3000 deltas with short text produced *zero* long tasks. The
   parse is proportional to the whole message, so the turn gets slower as it
   runs — quadratic overall.
2. **React 18 already coalesces per-event `setState`** (updates in one task
   flush once), so per-delta re-rendering was much less of a problem than it
   looked. The rAF layer in `useTurnRunner` still caps the worst case (history
   replay, very fast models, tool-loop bursts) and costs nothing, but it is not
   where the time went.
3. `applyMessageDelta` allocating three arrays per event is real but small next
   to (1); it now preserves identity when nothing changed, which is what makes
   `memo(ItemView)` effective.

## What the client does now

- `ItemView` renders an item's text as **plain wrapped text while it is still
  streaming** and parses markdown once, when the item settles (`streaming` prop,
  derived in `ChatView` from "the last row while this session is busy"). Side
  benefit: no half-rendered code fence or dangling `**` mid-stream.
- `ItemView`, `Sidebar`, `Header`, `Composer` are memoized, and the callbacks
  they receive are stable (`useCallback` on the stable leaf functions, not on
  the whole `chat`/`sessions` objects, which are new every render).
- `chatEvents` reducers return the same state object when they would change
  nothing.
- Streaming UI state is mirrored at most once per animation frame; turn end and
  abort cancel the queued frame and mirror synchronously.
- `ChatView` only calls `setAtEnd` when a scroll actually crosses the end
  boundary, so scrolling does not re-render the whole view.
- `busy` reaching the transcript is session-scoped (`busyHere` in `App`): a
  turn running in another session can no longer put a placeholder row, or
  live-render markup, onto the session on screen.

## Syntax highlighting (tree-sitter)

Code blocks are coloured by real parsers, not regexes: `@vscode/tree-sitter-wasm`
(the grammars VS Code ships, built with `tree-sitter build --wasm`, so they carry
the `dylink.0` section that `web-tree-sitter` ≥0.25 requires — the older
`tree-sitter-wasms` grammars are rejected by that loader). Runtime 206 KB
(82 KB gz), grammars 5–1400 KB each (js 51 KB gz, python 69 KB gz), emitted as
separate assets and fetched only for the language a block actually names.

Measured in the browser:

| block | size | cost | spans |
| ----- | ---- | ---- | ----- |
| 50 lines | 7 KB | 40ms first block (includes grammar load) | 1900 |
| 200 lines | 28 KB | 18ms | 3269 (head coloured, tail plain) |
| 800 lines | 115 KB | 15ms | 3269 — capped, so size stops mattering |

Two decisions came out of those numbers rather than taste:

- **Only 12 KB of a block is parsed**, cut at a line boundary, the rest stays
  plain. Without the cap a 1600-line dump cost 102ms and produced ~26k spans.
- **Delimiters are not coloured.** Giving `;`, `,`, `(` and `.` their own shade
  made more than half the spans for no gain in readability; operators keep a
  shade, everything else merges into plain runs (12 spans where it was 24).

Grammars do not share a semantic vocabulary, so the mapping in
`highlight-core.ts` keys off node-type naming conventions (`string_content`,
`property_identifier`, `type_identifier`) plus one structural fact: an *unnamed*
token whose text is word-shaped is a keyword, because the word-shaped anonymous
tokens in a grammar are exactly the keywords. No keyword list per language.

`read_file` results go through the same path, keyed by the *file's* extension
rather than a fence — a `.ts` file the agent reads reads like the file. The
tool's `[lines 4-103 of 512] ` annotation is stripped before parsing (it is not
source) and rendered plain, so the parser never sees it. The 12 KB cap and the
uncoloured fallback apply there too.

The rules are pure (a tree is read through a small structural type), so they are
unit-tested without loading any wasm. Unknown languages, missing grammars and
any wasm failure render the source uncoloured — never wrong.

## Still open

- Markdown is parsed once per finalized item; a 200 KB single reply still costs
  ~80ms in one commit. If that ever matters, parse in chunks or cache the AST.
- `rowsToItems` rebuilds every item on session open — fine at current sizes.
- Row-height churn on very long tool output is unmeasured; measurements are now
  dropped when a different session is opened, and rows are keyed by tool-call id
  so a card keeps its measured height across a reopen.
- A turn that streams thousands of *items* (not one long one) still renders one
  commit per frame; each commit only touches the changed row (`memo` + identity
  preserving reducers), so the cost is the virtualizer's own bookkeeping.
