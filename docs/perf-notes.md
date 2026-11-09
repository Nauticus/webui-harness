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

- Assistant text is rendered by **Streamdown** in streaming mode: it splits the
  reply into top-level blocks, memoizes the finished ones, and re-renders only
  the block still being written, so formatting is live while the text arrives.
  See "Markdown rendering" below for what that costs and why the mode never
  switches.
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

## Markdown rendering (streamdown)

Markdown used to be rendered by `react-markdown`, and only once an item settled:
re-parsing the whole growing reply per commit is quadratic, and it was the
single biggest client cost. `streamdown` is built for text that arrives in
pieces, so it is now the renderer and formatting is live.

Measured on the same stream — 3000 deltas, ~185 KB of markdown (headings,
paragraphs, lists, code fences), 4 ms apart, real client, real SSE:

| | react-markdown, parse at settle | streamdown, streaming mode | streamdown, switching to static at settle |
|---|---|---|---|
| long tasks | 2 | **2** | 5 |
| long-task time | 849 ms | **100 ms** | 1230 ms |
| longest task | 709 ms | **50 ms** | 899 ms |
| frames showing formatting | 1 (at the end) | **81 of 81** | 81 of 81 |
| history open (same reply) | **884 ms** | 1357 ms | — |

Two findings worth keeping:

- **Do not switch mode when an item settles.** Going from `streaming` to
  `static` discards the block list and remounts every block in one commit — a
  899 ms task at the exact moment a reply finishes. Staying in streaming mode
  makes that 50 ms. The cost moves to opening long old history instead
  (+470 ms on 185 KB, because each block is its own memoized render), which is
  the better place to pay it.
- **A react-markdown call has a ~0.13–0.3 ms fixed cost**, so anything that
  calls a React markdown renderer per token pays 3000 × that regardless of text
  size. Block memoization only wins once the blocks are big enough for the
  saving to beat that floor — for short replies, naive live formatting is
  cheaper than splitting.

Cost of the swap: the main chunk goes from 785 KB to 1225 KB raw (232 KB to
354 KB gzipped), because streamdown brings `marked`, `unified`, and three
rehype plugins. Shiki is not among it: the `code` override keeps tree-sitter,
so no shiki bundle is fetched.

One behaviour change to know about: streamdown runs raw HTML in markdown
through `rehype-raw` and then sanitizes it, where react-markdown escaped it as
text. Checked against a hostile sample — `<script>`, `<img onerror>`,
`onclick=`, and a `javascript:` link all produce nothing, no `<img>` element at
all, no dialog, no page error — but HTML in model output now renders as markup
rather than as literal text. `literalTagContent` on the `Streamdown` call
restores the old behaviour in one line if that is ever preferred.

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

## The other surfaces

- **Diffs** (`DiffView`) colour the changed lines as source, not just green and
  red. A diff line is a fragment, so it is not parsed alone: the post-image
  (context + additions) and the pre-image (context + deletions) are each parsed
  once and the tokens are handed back per line, which is what lets `} else {`
  and a bare `}` come out right. Two parses per diff, bounded by the same 12 KB
  cap; `git diff` in a bash card is detected from the text and gets the same
  treatment, with the file taken from the diff header. A card shows the first
  `CARD_LINES` rows and counts the rest — no preview, no folded context, and no
  scrollbar of its own — and the expand control opens those same rows at reading
  size in a dialog: the same tokens, nothing re-parsed, so its only extra cost is
  a second copy of the rows while it is open. Split mode pairs them into columns
  with one pure pass over the rows (`splitRows`, memoized per diff), and the
  dialog widens to 1600px so each side keeps a readable measure; the card itself
  is always inline.
- **The chat view has the app's only scrollbar.** A card that scrolls is a wheel
  that never reaches the transcript, and a 240px window onto a 3000-line result
  is not a readable thing to drag, so tool output, skill instructions, arguments
  and diffs *truncate* instead (`clipText`, `OutputBlock`): the lines that fit,
  how many were left out, and the same expand icon the diff uses. The budget is
  14 lines and 20 KB — the second is the backstop for output with no newlines in
  it, which would otherwise put every byte in the DOM because line counting
  found nothing to stop at. Markdown tables wrap rather than scroll, which is why
  the renderer overrides streamdown's table box instead of inheriting its
  scroller. The only surfaces that still scroll are the transcript and an open
  dialog — a dialog with no scrollbar could not show a long result at all, and it
  is not nested scrolling: nothing inside the chat is moving, the chat is covered.
  `overscroll-behavior` keeps a finished scroll where it started; at browser zoom
  the fractional 100% heights leave the document a few pixels scrollable on each
  axis, which is why the root is `overflow: clip`.
- **Tool arguments** are rendered from the value itself rather than a
  stringified blob — exact by construction, no parser involved.
- **Command output** is arbitrary text, so only two things are detected from it:
  a unified diff (hunk header *and* file header, so a log line that merely
  mentions `@@` stays a log line) and a whole-JSON-document. Everything else
  stays plain terminal text on purpose: colouring a build log as if it were
  source would buy decoration at the cost of trust. The *command* that produced
  it is a different matter — it is shell, and the dialog shows it above the
  output with the `$` from the card, parsed with the bash or powershell grammar
  already in the bundle. Which one comes from the server, not a guess: `shellFor`
  picks the shell from the platform, the tool description names it to the model,
  `spawn` runs it, and the result carries its name out through `tool.result` and
  the stored row so a reopened session colours the same line the same way.
  History from before that field defaults to bash, which is the only thing that
  can have run it.

  Both grammars label the program, its flags and its arguments as leaves whose
  types say nothing — `word` in bash, `command_parameter` under
  `command_elements` in powershell — so the walker passes a role down: the first
  child of a `command` is the program, a `-x`-shaped word among its arguments is
  a flag, and only inside a `command` node, so no other language sees the rule.
  `2>&1`'s `1` still reads as a number, not a flag. Powershell colours correctly
  through this; cmd-style `/switches` stay plain, and they should — teaching the
  rule about `/x` would make `ls /var/log` colour `/var` as a flag.

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
