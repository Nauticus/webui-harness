import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { api } from './api';
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

/** Full-width context-usage bar, sitting on the border between the chat
 * and the composer. Amber when compaction is armed, red at the wall. */
function ContextBar({ tokens, window, threshold }: { tokens: number; window: number; threshold: number }) {
  const pct = Math.max(0, Math.min(100, (tokens / window) * 100));
  const armed = pct >= threshold;
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

  const chat = useChatTurn({
    activeProjectId: projectId ?? null,
    activeSessionId: sessionId ?? null,
    activeSessionModel: activeSession?.model ?? '',
    activeSessionEffort: activeSession?.reasoning_effort ?? '',
    refreshSessions: sessions.refreshSessions,
    onSessionCreated: (id) =>
      projectId && navigate({ to: '/$projectId/$sessionId', params: { projectId, sessionId: id } }),
    onSessionModelUpdated: (id, model) => sessions.updateSessionLocal(id, { model }),
    onSessionEffortUpdated: (id, reasoningEffort) =>
      sessions.updateSessionLocal(id, { reasoningEffort }),
  });

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
    const s = await api.createSession(projectId, chat.pendingModelFor(projectId));
    chat.clearPendingModel(projectId);
    await sessions.refreshSessions(projectId);
    navigate({ to: '/$projectId/$sessionId', params: { projectId, sessionId: s.id } });
    setLoadError(null);
  }, [projectId, chat, sessions, navigate]);

  const removeSession = useCallback(
    async (id: string) => {
      await sessions.removeSession(id);
      if (projectId) await sessions.refreshSessions(projectId);
      if (sessionId === id && projectId) {
        navigate({ to: '/$projectId', params: { projectId } });
      }
    },
    [projectId, sessionId, sessions, navigate]
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

  // Banner: a turn is running in another session.
  const runningElsewhere = chat.runningSessionId && chat.runningSessionId !== sessionId;
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
        onNewSession={() => void newSession()}
        onSelect={loadSession}
        onRemove={(id) => void removeSession(id)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <Header
          projects={projects.projects}
          activeProject={activeProject}
          providersOpen={providersOpen}
          hasDetectionFailure={providers.hasDetectionFailure}
          onToggleProviders={() => {
            setProvidersOpen((v) => !v);
            setDialog(null);
          }}
          onSelectProject={selectProject}
          onNewProject={() => setDialog({ mode: 'create' })}
          onEditProject={() => activeProject && setDialog({ mode: 'edit', project: activeProject })}
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
                onClick={() => chat.abort()}
                className="rounded border border-rose-500/40 px-2 py-0.5 text-rose-300 transition-colors hover:bg-rose-500/15"
              >
                Stop
              </button>
            </span>
          </div>
        )}

        <ChatView
          items={chat.items}
          busy={chat.busy}
          onboarding={onboarding}
          activeProject={activeProject}
          hasActiveSession={sessionId !== null}
          loadError={loadError}
          onCreateProject={() => setDialog({ mode: 'create' })}
          context={chat.context}
          skills={skills}
        />
        {chat.context && chat.context.window > 0 && (
          <ContextBar tokens={chat.context.tokens} window={chat.context.window} threshold={chat.context.threshold} />
        )}
        <Composer
          model={chat.modelValue}
          modelGroups={composerProvider?.model_groups ?? []}
          defaultModel={composerProvider?.default_model ?? ''}
          defaultEffort={composerProvider?.default_reasoning_effort ?? ''}
          input={chat.input}
          busy={chat.busy}
          disabled={!activeProject}
          placeholder={activeProject ? 'Ask the agent to do something…' : 'Create a project first…'}
          onModelChange={(v) => void chat.setModel(v)}
          onEffortChange={(v) => void chat.setEffort(v)}
          effort={chat.effortValue}
          onInput={chat.setInput}
          onKeyDown={chat.onKeyDown}
          onSend={() => void chat.send()}
          onStop={() => chat.abort()}
          skills={skills}
        />
      </main>
    </div>
  );
}
