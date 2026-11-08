import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { api, type ModelGroup } from './api';
import { useProjects } from './hooks/useProjects';
import { useSessions } from './hooks/useSessions';
import { useProviders } from './hooks/useProviders';
import { useSkills } from './hooks/useSkills';
import { useChatTurn } from './hooks/useChatTurn';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { ChatView } from './components/ChatView';
import { Composer } from './components/Composer';
import { ProjectDialog, type ProjectDialogState } from './components/dialogs/ProjectDialog';
import { ProvidersPanel } from './components/dialogs/ProvidersPanel';

/** Stable empty fallback: an inline `[]` would be a new prop on every render
 *  and defeat the memoized composer. */
const NO_GROUPS: ModelGroup[] = [];

/** Full-width context-usage bar, sitting on the border between the chat
 * and the composer. Amber when compaction is armed, red at the wall.
 * `threshold` is a token count (the server's compaction trigger), not a
 * percentage — comparing it against the percentage made it unreachable. */
function ContextBar({ tokens, window, threshold }: { tokens: number; window: number; threshold: number }) {
  const pct = Math.max(0, Math.min(100, (tokens / window) * 100));
  const armed = tokens >= threshold;
  const tone = pct >= 100 ? 'bg-red-500' : armed ? 'bg-amber-500' : 'bg-indigo-500';
  return (
    <div
      className="relative h-[3px] w-full shrink-0 bg-neutral-800/70"
      title={`context ${pct.toFixed(0)}% used (${Math.round(tokens / 1000)}k / ${Math.round(window / 1000)}k tokens${armed ? ' — compaction armed' : ''})`}
    >
      <div className={`h-full transition-[width] duration-300 ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * App shell: sidebar + header + chat. The project/session selection lives in
 * the URL (TanStack Router); this component is the shared layout for the
 * `/`, `/$projectId` and `/$projectId/$sessionId` routes.
 */
export default function App() {
  // The URL IS the selection: /:projectId[/:sessionId].
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [, projectId, sessionId] = pathname.split('/');
  const navigate = useNavigate();
  const projects = useProjects();
  const sessions = useSessions();
  // Skills for the active workspace (global + project) — composer
  // autocomplete, skill chips, and SkillCards in the chat.
  const { skills } = useSkills(projectId ?? null);
  const providers = useProviders();
  const [dialog, setDialog] = useState<ProjectDialogState | null>(null);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const activeProject = projects.projects.find((p) => p.id === projectId) ?? null;
  const composerProvider = providers.composerProvider(activeProject?.provider_id);
  const activeSession = sessions.sessions.find((s) => s.id === sessionId) ?? null;
  // Stable pieces of the hooks: the memoized composer/sidebar/header compare
  // props by identity, so the callbacks handed to them must not be rebuilt on
  // every render (which happens once per streamed frame).
  const { refreshSessions, removeSession: deleteSession, updateSessionLocal } = sessions;
  const onSessionModelUpdated = useCallback(
    (id: string, model: string) => updateSessionLocal(id, { model }),
    [updateSessionLocal]
  );
  const onSessionEffortUpdated = useCallback(
    (id: string, reasoningEffort: string) => updateSessionLocal(id, { reasoningEffort }),
    [updateSessionLocal]
  );

  const chat = useChatTurn({
    activeProjectId: projectId ?? null,
    activeSessionId: sessionId ?? null,
    activeSessionModel: activeSession?.model ?? '',
    activeSessionEffort: activeSession?.reasoning_effort ?? '',
    refreshSessions: sessions.refreshSessions,
    onSessionCreated: (id) =>
      projectId && navigate({ to: '/$projectId/$sessionId', params: { projectId, sessionId: id } }),
    onSessionModelUpdated: onSessionModelUpdated,
    onSessionEffortUpdated: onSessionEffortUpdated,
  });
  const { pendingModelFor, clearPendingModel } = chat;

  // First load: fetch providers + projects. On the bare root (no project in
  // the URL) redirect to the first project and its first session.
  useEffect(() => {
    (async () => {
      providers.refreshProviders().catch(() => {});
      try {
        const first = await projects.initialLoad();
        if (!projectId && first) {
          const list = await sessions.refreshSessions(first.id);
          navigate(
            list.length > 0
              ? { to: '/$projectId/$sessionId', params: { projectId: first.id, sessionId: list[0]!.id }, replace: true }
              : { to: '/$projectId', params: { projectId: first.id }, replace: true }
          );
        }
      } catch (err) {
        setLoadError(String(err instanceof Error ? err.message : err));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Project switched (or cleared): reset the session list.
  useEffect(() => {
    sessions.selectProject(projectId ?? null);
    if (projectId) {
      sessions.refreshSessions(projectId).catch((err) =>
        setLoadError(String(err instanceof Error ? err.message : err))
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Session (or project) changed: show that session's items — live items when
  // a turn is running in it, history otherwise. Never aborts a running turn.
  useEffect(() => {
    chat
      .viewSession(sessionId ?? null)
      .then(() => setLoadError(null))
      .catch((err) => setLoadError(String(err instanceof Error ? err.message : err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sessionId]);

  const selectProject = useCallback(
    (id: string) => {
      setLoadError(null);
      navigate({ to: '/$projectId', params: { projectId: id } });
    },
    [navigate]
  );

  const loadSession = useCallback(
    (id: string) => {
      if (!projectId) return;
      navigate({ to: '/$projectId/$sessionId', params: { projectId, sessionId: id } });
    },
    [navigate, projectId]
  );

  const newSession = useCallback(async () => {
    if (!projectId) return;
    const s = await api.createSession(projectId, pendingModelFor(projectId));
    clearPendingModel(projectId);
    await refreshSessions(projectId);
    navigate({ to: '/$projectId/$sessionId', params: { projectId, sessionId: s.id } });
    setLoadError(null);
  }, [projectId, pendingModelFor, clearPendingModel, refreshSessions, navigate]);

  const removeSession = useCallback(
    async (id: string, title: string) => {
      // One click used to delete the session and its history outright.
      if (!window.confirm(`Delete “${title}”? Its history is deleted too.`)) return;
      await deleteSession(id);
      if (projectId) await refreshSessions(projectId);
      if (sessionId === id && projectId) {
        navigate({ to: '/$projectId', params: { projectId } });
      }
    },
    [projectId, sessionId, deleteSession, refreshSessions, navigate]
  );

  const onProjectCreated = useCallback(
    async (p: { id: string }) => {
      await projects.refreshProjects();
      setDialog(null);
      navigate({ to: '/$projectId', params: { projectId: p.id } });
    },
    [projects, navigate]
  );

  const onProjectUpdated = useCallback(async () => {
    await projects.refreshProjects();
    setDialog(null);
  }, [projects]);

  const onProjectDeleted = useCallback(
    async (id: string) => {
      await api.deleteProject(id);
      const remaining = await api.listProjects();
      projects.setProjects(remaining);
      setDialog(null);
      if (projectId === id) {
        if (remaining.length > 0) {
          navigate({ to: '/$projectId', params: { projectId: remaining[0]!.id }, replace: true });
        } else {
          navigate({ to: '/', replace: true });
        }
      }
    },
    [projectId, projects, navigate]
  );

  const onboarding = projects.projectsLoaded && projects.projects.length === 0;

  // Callbacks for the memoized shell parts: rebuilt only when what they act on
  // changes, never because a token arrived.
  const onNewSession = useCallback(() => void newSession(), [newSession]);
  const onRemoveSession = useCallback(
    (id: string, title: string) => void removeSession(id, title),
    [removeSession]
  );
  const onToggleProviders = useCallback(() => {
    setProvidersOpen((v) => !v);
    setDialog(null);
  }, []);
  const onNewProject = useCallback(() => setDialog({ mode: 'create' }), []);
  const onEditProject = useCallback(
    () => activeProject && setDialog({ mode: 'edit', project: activeProject }),
    [activeProject]
  );
  const onSend = useCallback(() => void chat.send(), [chat.send]);
  const onStop = useCallback(() => chat.abort(), [chat.abort]);
  const onModelChange = useCallback((v: string) => void chat.setModel(v), [chat.setModel]);
  const onEffortChange = useCallback((v: string) => void chat.setEffort(v), [chat.setEffort]);

  // Banner: a turn is running in another session.
  const runningElsewhere = chat.runningSessionId && chat.runningSessionId !== sessionId;
  // Only this session's own turn may make the transcript look busy: `chat.busy`
  // is global, so a turn in another session would otherwise put a placeholder
  // (and live-rendering markup) on a static transcript.
  const busyHere = chat.busy && chat.runningSessionId === sessionId;
  const runningTitle = runningElsewhere
    ? sessions.sessions.find((s) => s.id === chat.runningSessionId)?.title ?? 'another session'
    : '';

  return (
    <div className="flex h-full bg-slate-950 text-slate-100">
      <Sidebar
        sessions={sessions.sessions}
        activeProject={activeProject}
        activeSessionId={sessionId ?? null}
        runningSessionId={chat.runningSessionId}
        onNewSession={onNewSession}
        onSelect={loadSession}
        onRemove={onRemoveSession}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <Header
          projects={projects.projects}
          activeProject={activeProject}
          providersOpen={providersOpen}
          hasDetectionFailure={providers.hasDetectionFailure}
          onToggleProviders={onToggleProviders}
          onSelectProject={selectProject}
          onNewProject={onNewProject}
          onEditProject={onEditProject}
        />

        {providersOpen && (
          <ProvidersPanel
            providers={providers.providers}
            onClose={() => setProvidersOpen(false)}
            onChanged={providers.refreshProviders}
          />
        )}

        {dialog && (
          <ProjectDialog
            dialog={dialog}
            providers={providers.providers}
            onClose={() => setDialog(null)}
            onCreated={(p) => void onProjectCreated(p)}
            onUpdated={() => void onProjectUpdated()}
            onDeleted={(id) => void onProjectDeleted(id)}
          />
        )}

        {runningElsewhere && (
          <div className="flex shrink-0 items-center gap-3 border-b border-sky-900/60 bg-sky-950/40 px-4 py-1.5 text-xs text-sky-300">
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-400" />
            <span className="min-w-0 truncate">Agent running in &ldquo;{runningTitle}&rdquo;</span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <button
                onClick={() => loadSession(chat.runningSessionId!)}
                className="rounded border border-sky-500/40 px-2 py-0.5 text-sky-300 transition-colors hover:bg-sky-500/15"
              >
                Open
              </button>
              <button
                onClick={onStop}
                className="rounded border border-rose-500/40 px-2 py-0.5 text-rose-300 transition-colors hover:bg-rose-500/15"
              >
                Stop
              </button>
            </span>
          </div>
        )}

        <ChatView
          items={chat.items}
          busy={busyHere}
          sessionId={sessionId ?? null}
          onboarding={onboarding}
          activeProject={activeProject}
          hasActiveSession={sessionId !== null}
          loadError={loadError}
          onCreateProject={onNewProject}
          context={chat.context}
          skills={skills}
        />
        {chat.context && chat.context.window > 0 && (
          <ContextBar tokens={chat.context.tokens} window={chat.context.window} threshold={chat.context.threshold} />
        )}
        <Composer
          model={chat.modelValue}
          modelGroups={composerProvider?.model_groups ?? NO_GROUPS}
          defaultModel={composerProvider?.default_model ?? ''}
          defaultEffort={composerProvider?.default_reasoning_effort ?? ''}
          input={chat.input}
          busy={chat.busy}
          disabled={!activeProject}
          placeholder={activeProject ? 'Ask the agent to do something…' : 'Create a project first…'}
          onModelChange={onModelChange}
          onEffortChange={onEffortChange}
          effort={chat.effortValue}
          onInput={chat.setInput}
          onKeyDown={chat.onKeyDown}
          onSend={onSend}
          onStop={onStop}
          skills={skills}
        />
      </main>
    </div>
  );
}
