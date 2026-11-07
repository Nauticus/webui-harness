import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { api, streamTurn } from '../api';
import { rowsToItems, type Item } from '../lib/items';

/** Current context size vs the model's window and compaction threshold. */
export interface ContextUsage {
  tokens: number;
  window: number;
  threshold: number;
}

/**
 * The chat turn engine: items state, the SSE stream loop, send(), and the
 * per-chat model selection (pending until a session exists, then a real
 * session patch). Blocks are appended in server stream order.
 */
export function useChatTurn(opts: {
  activeProjectId: string | null;
  activeSessionId: string | null;
  activeSessionModel: string; // '' = auto
  refreshSessions: (projectId: string) => Promise<void>;
  /** called with the new session id when the first message creates one */
  onSessionCreated: (id: string) => void;
  /** update the local session row after a model patch */
  onSessionModelUpdated: (sessionId: string, model: string) => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [context, setContext] = useState<ContextUsage | null>(null);
  const [pendingModels, setPendingModels] = useState<Record<string, string>>({});
  const streamedRef = useRef(false);

  const clear = useCallback(() => {
    setItems([]);
    setContext(null);
  }, []);

  const pendingModelFor = useCallback(
    (projectId: string) => pendingModels[projectId] ?? '',
    [pendingModels]
  );
  const clearPendingModel = useCallback((projectId: string) => {
    setPendingModels((prev) => {
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
  }, []);

  const loadHistory = useCallback(async (sessionId: string) => {
    const { messages } = await api.getSession(sessionId);
    setItems(rowsToItems(messages));
  }, []);

  /** The composer select value: session's model, else the pending pick. */
  const modelValue =
    opts.activeSessionId !== null ? opts.activeSessionModel : pendingModels[opts.activeProjectId ?? ''] ?? '';

  const setModel = useCallback(
    async (v: string) => {
      if (opts.activeSessionId) {
        await api.updateSessionModel(opts.activeSessionId, v);
        opts.onSessionModelUpdated(opts.activeSessionId, v);
      } else if (opts.activeProjectId) {
        setPendingModels((prev) => ({ ...prev, [opts.activeProjectId!]: v }));
      }
    },
    [opts]
  );

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content || busy || !opts.activeProjectId) return;

    let sessionId = opts.activeSessionId;
    if (!sessionId) {
      const s = await api.createSession(opts.activeProjectId, pendingModels[opts.activeProjectId]);
      setPendingModels((prev) => {
        const next = { ...prev };
        delete next[opts.activeProjectId!];
        return next;
      });
      await opts.refreshSessions(opts.activeProjectId);
      sessionId = s.id;
      opts.onSessionCreated(s.id);
      setItems([]);
      setContext(null); // fresh session: no history context yet
    }
    setInput('');
    setBusy(true);
    streamedRef.current = false;
    // Only the user item is pre-created; thinking/assistant/tool blocks are
    // appended as they arrive so the UI matches the server's stream order.
    setItems((prev) => [...prev, { kind: 'user', content }]);

    try {
      await streamTurn(sessionId, content, (ev) => {
        switch (ev.type) {
          case 'message.delta': {
            streamedRef.current = true;
            setItems((prev) => {
              const next = prev.map((it) =>
                it.kind === 'thinking' && !it.done ? { ...it, done: true } : it
              );
              const last = next[next.length - 1];
              if (last && last.kind === 'assistant') {
                next[next.length - 1] = { kind: 'assistant', content: last.content + String(ev.text) };
              } else {
                next.push({ kind: 'assistant', content: String(ev.text) });
              }
              return next;
            });
            break;
          }
          case 'thinking.delta':
            setItems((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.kind === 'thinking' && !last.done) {
                next[next.length - 1] = { ...last, content: last.content + String(ev.text) };
              } else {
                next.push({ kind: 'thinking', content: String(ev.text), done: false });
              }
              return next;
            });
            break;
          case 'tool.start':
            setItems((prev) =>
              prev.map((it) => (it.kind === 'thinking' && !it.done ? { ...it, done: true } : it))
            );
            setItems((prev) => [
              ...prev,
              { kind: 'tool', id: String(ev.id), name: String(ev.name), args: ev.args },
            ]);
            break;
          case 'tool.result':
            setItems((prev) =>
              prev.map((it) =>
                it.kind === 'tool' && it.id === String(ev.id)
                  ? {
                      ...it,
                      result: String(ev.result),
                      ...(typeof ev.diff === 'string' ? { diff: ev.diff } : {}),
                    }
                  : it
              )
            );
            break;
          case 'message.complete':
            setItems((prev) =>
              prev.map((it) => (it.kind === 'thinking' && !it.done ? { ...it, done: true } : it))
            );
            if (String(ev.content) && !streamedRef.current) {
              setItems((prev) => [...prev, { kind: 'assistant', content: String(ev.content) }]);
            }
            if (typeof ev.tokens === 'number') {
              setContext((c) => (c ? { ...c, tokens: Number(ev.tokens) } : c));
            }
            break;
          case 'error':
            setItems((prev) => [...prev, { kind: 'error', message: String(ev.message) }]);
            break;
          case 'compaction':
            // (Mid-)turn compaction: the model's context was just summarized.
            setItems((prev) => [...prev, { kind: 'compaction' }]);
            if (typeof ev.tokensAfter === 'number') {
              setContext((c) => (c ? { ...c, tokens: Number(ev.tokensAfter) } : c));
            }
            break;
          case 'context':
            setContext({
              tokens: Number(ev.tokens),
              window: Number(ev.window),
              threshold: Number(ev.threshold),
            });
            break;
          default:
            break;
        }
      });
      await opts.refreshSessions(opts.activeProjectId);
    } catch (err) {
      setItems((prev) => [
        ...prev,
        { kind: 'error', message: String(err instanceof Error ? err.message : err) },
      ]);
    } finally {
      setBusy(false);
    }
  }, [input, busy, opts]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return {
    items,
    input,
    setInput,
    busy,
    send,
    context,
    modelValue,
    setModel,
    loadHistory,
    clear,
    pendingModelFor,
    clearPendingModel,
    onKeyDown,
  };
}
