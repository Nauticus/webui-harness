import type { ContextUsage, ServerEvent } from '../api';
import type { Item } from './items';

/**
 * Pure chat-event reducer: folds server stream events into the running
 * turn's state. No React, no side effects — each event type is a small
 * named function, so the streaming contract is unit-testable in isolation.
 */
export interface TurnState {
  items: Item[];
  /** True once a message.delta arrived (the reply is streaming). */
  streamed: boolean;
  /** Last known context usage for the running session. */
  context: ContextUsage | null;
}

export function initialTurnState(): TurnState {
  return { items: [], streamed: false, context: null };
}

/**
 * A non-thinking event arrived: any still-streaming thinking block is
 * finished, so mark it done. This runs on every delta, so it looks first and
 * only allocates when something actually needs settling — most of the time
 * the answer is "nothing open" and the array keeps its identity.
 */
function settleThinking(items: Item[]): Item[] {
  let open = false;
  for (const it of items) {
    if (it.kind === 'thinking' && !it.done) {
      open = true;
      break;
    }
  }
  return open ? items.map((it) => (it.kind === 'thinking' && !it.done ? { ...it, done: true } : it)) : items;
}

/** Text from an event, without `String(undefined)` writing "undefined" into a
 *  reply: a malformed event should add nothing, not a phantom word. */
const textOf = (v: unknown): string => (typeof v === 'string' ? v : '');

function applyMessageDelta(state: TurnState, ev: ServerEvent): TurnState {
  const items = settleThinking(state.items);
  const text = textOf(ev.text);
  const last = items[items.length - 1];
  // One array copy per delta: this is the hot path of a streaming reply.
  const next = items.slice();
  if (last && last.kind === 'assistant') {
    next[next.length - 1] = { kind: 'assistant', content: last.content + text };
  } else {
    next.push({ kind: 'assistant', content: text });
  }
  return { ...state, streamed: true, items: next };
}

function applyThinkingDelta(state: TurnState, ev: ServerEvent): TurnState {
  const items = [...state.items];
  const last = items[items.length - 1];
  if (last && last.kind === 'thinking' && !last.done) {
    items[items.length - 1] = { kind: 'thinking', content: last.content + textOf(ev.text), done: false };
  } else {
    items.push({ kind: 'thinking', content: textOf(ev.text), done: false });
  }
  return { ...state, items };
}

function applyToolStart(state: TurnState, ev: ServerEvent): TurnState {
  return {
    ...state,
    items: [
      ...settleThinking(state.items),
      { kind: 'tool', id: String(ev.id), name: String(ev.name), args: ev.args },
    ],
  };
}

function applyToolResult(state: TurnState, ev: ServerEvent): TurnState {
  const id = String(ev.id);
  const i = state.items.findIndex((it) => it.kind === 'tool' && it.id === id);
  // No matching card: the state keeps its identity, so nothing re-renders.
  if (i === -1) return state;
  const card = state.items[i] as Extract<Item, { kind: 'tool' }>;
  const items = state.items.slice();
  items[i] = {
    ...card,
    result: String(ev.result),
    ...(ev.ok === false ? { ok: false } : {}),
    ...(typeof ev.diff === 'string' ? { diff: ev.diff } : {}),
    ...(ev.shell === 'powershell' || ev.shell === 'bash' ? { shell: ev.shell } : {}),
  };
  return { ...state, items };
}

/**
 * Refine the last known context with a new token count. Only when a
 * context already exists — these events refine, they do not create.
 */
function withTokens(state: TurnState, tokens: unknown): TurnState {
  return typeof tokens === 'number' && state.context
    ? { ...state, context: { ...state.context, tokens: Number(tokens) } }
    : state;
}

/**
 * Append the reply's text when it never streamed (no delta was seen), so
 * non-streaming providers still get their answer rendered.
 */
function appendIfNotStreamed(state: TurnState, content: unknown): TurnState {
  return String(content) && !state.streamed
    ? { ...state, items: [...state.items, { kind: 'assistant', content: String(content) }] }
    : state;
}

function applyMessageComplete(state: TurnState, ev: ServerEvent): TurnState {
  return withTokens(appendIfNotStreamed({ ...state, items: settleThinking(state.items) }, ev.content), ev.tokens);
}

/**
 * Append the stop marker — once. Both abort() and a `message.stopped` event
 * that arrives in the same window can reach the same turn, and a marker is
 * already in the items after a reload.
 */
export function withStopped(state: TurnState): TurnState {
  return state.items[state.items.length - 1]?.kind === 'stopped'
    ? state
    : { ...state, items: [...state.items, { kind: 'stopped' }] };
}

function applyMessageStopped(state: TurnState, ev: ServerEvent): TurnState {
  let s = appendIfNotStreamed({ ...state, items: settleThinking(state.items) }, ev.content);
  s = withStopped(s);
  return withTokens(s, ev.tokens);
}

function applyError(state: TurnState, ev: ServerEvent): TurnState {
  return { ...state, items: [...state.items, { kind: 'error', message: String(ev.message) }] };
}

function applyCompactionStart(state: TurnState, ev: ServerEvent): TurnState {
  return {
    ...state,
    items: [
      ...state.items,
      { kind: 'compaction', status: 'running', tokensBefore: Number(ev.tokensBefore) },
    ],
  };
}

function applyCompactionProgress(state: TurnState, ev: ServerEvent): TurnState {
  for (let i = state.items.length - 1; i >= 0; i--) {
    const it = state.items[i]!;
    if (it.kind === 'compaction' && it.status === 'running') {
      const items = [...state.items];
      items[i] = { ...it, tokensOut: Number(ev.tokensOut) };
      return { ...state, items };
    }
  }
  return state; // no running card (start event missed) — nothing to update
}

function applyCompactionDone(state: TurnState, ev: ServerEvent): TurnState {
  const done: Item = {
    kind: 'compaction',
    status: 'done',
    summary: String(ev.summary),
    tokensBefore: Number(ev.tokensBefore),
    tokensAfter: Number(ev.tokensAfter),
  };
  const items = [...state.items];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'compaction' && it.status === 'running') {
      items[i] = { ...done, tokensOut: it.tokensOut };
      return { ...state, items };
    }
  }
  return { ...state, items: [...items, done] }; // start event missed — add a fresh card
}

function applyContext(state: TurnState, ev: ServerEvent): TurnState {
  return {
    ...state,
    context: {
      tokens: Number(ev.tokens),
      window: Number(ev.window),
      threshold: Number(ev.threshold),
    },
  };
}

/**
 * Fold one server event into the turn state. Unknown event types are
 * ignored (forward compatibility with new server events).
 */
export function applyEvent(state: TurnState, ev: ServerEvent): TurnState {
  switch (ev.type) {
    case 'message.delta':
      return applyMessageDelta(state, ev);
    case 'thinking.delta':
      return applyThinkingDelta(state, ev);
    case 'tool.start':
      return applyToolStart(state, ev);
    case 'tool.result':
      return applyToolResult(state, ev);
    case 'message.complete':
      return applyMessageComplete(state, ev);
    case 'message.stopped':
      return applyMessageStopped(state, ev);
    case 'error':
      return applyError(state, ev);
    case 'compaction.start':
      return applyCompactionStart(state, ev);
    case 'compaction.progress':
      return applyCompactionProgress(state, ev);
    case 'compaction':
      return applyCompactionDone(state, ev);
    case 'context':
      return applyContext(state, ev);
    default:
      return state;
  }
}

/**
 * A turn interrupted by stop/error never gets its compaction end event:
 * settle the running card so it doesn't pulse forever. Returns the same state
 * when there is nothing running.
 */
export function settleCompaction(state: TurnState): TurnState {
  if (!state.items.some((it) => it.kind === 'compaction' && it.status === 'running')) return state;
  return {
    ...state,
    items: state.items.map((it) =>
      it.kind === 'compaction' && it.status === 'running' ? { ...it, status: 'done' } : it
    ),
  };
}
