import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useProjects } from './hooks/useProjects';
import { useSessions } from './hooks/useSessions';
import { useProviders } from './hooks/useProviders';
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

export default function App() {
  const projects = useProjects();
  const sessions = useSessions();
  const providers = useProviders();
  const [dialog, setDialog] = useState<ProjectDialogState | null>(null);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const chat = useChatTurn({
    activeProjectId: projects.activeProjectId,
    activeSessionId: sessions.activeSessionId,
    activeSessionModel: sessions.activeSession?.model ?? '',
    activeSessionEffort: sessions.activeSession?.reasoning_effort ?? '',
    refreshSessions: sessions.refreshSessions,
    onSessionCreated: (id) => sessions.setActiveSessionId(id),
    onSessionModelUpdated: (id, model) => sessions.updateSessionLocal(id, { model }),
    onSessionEffortUpdated: (id, reasoningEffort) =>
      sessions.updateSessionLocal(id, { reasoningEffort }),
  });

  // On first load: fetch projects, activate the first one (or open the dialog).
  useEffect(() => {
    (async () => {
      providers.refreshProviders().catch(() => {});
      try {
        const first = await projects.initialLoad();
        if (first) {
          await sessions.refreshSessions(first.id);
        } else {
          setDialog({ mode: 'create' });
        }
      } catch (err) {
        setLoadError(String(err instanceof Error ? err.message : err));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectProject = useCallback(
    async (id: string) => {
      projects.setActiveProjectId(id);
      sessions.selectProject(id);
      chat.clear();
      setLoadError(null);
      try {
        await sessions.refreshSessions(id);
      } catch (err) {
        setLoadError(String(err instanceof Error ? err.message : err));
      }
    },
    [projects, sessions, chat]
  );
  const selectProjectRef = useRef(selectProject);
  selectProjectRef.current = selectProject;

  const loadSession = useCallback(
    async (id: string) => {
      try {
        await chat.loadHistory(id);
        sessions.setActiveSessionId(id);
        setLoadError(null);
      } catch (err) {
        setLoadError(String(err instanceof Error ? err.message : err));
      }
    },
    [chat, sessions]
  );

  const newSession = useCallback(async () => {
    if (!projects.activeProjectId) return;
    const s = await api.createSession(
      projects.activeProjectId,
      chat.pendingModelFor(projects.activeProjectId)
    );
    chat.clearPendingModel(projects.activeProjectId);
    await sessions.refreshSessions(projects.activeProjectId);
    sessions.setActiveSessionId(s.id);
    chat.clear();
    setLoadError(null);
  }, [projects, chat, sessions]);

  const removeSession = useCallback(
    async (id: string) => {
      const wasActive = sessions.activeSessionId === id;
      await sessions.removeSession(id);
      if (projects.activeProjectId) {
        if (wasActive) chat.clear();
        await sessions.refreshSessions(projects.activeProjectId);
      }
    },
    [projects, sessions, chat]
  );

  const onProjectCreated = useCallback(
    async (p: { id: string }) => {
      await projects.refreshProjects();
      setDialog(null);
      await selectProjectRef.current(p.id);
    },
    [projects]
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
      if (projects.activeProjectId === id) {
        sessions.selectProject(id);
        chat.clear();
        if (remaining.length > 0) {
          const first = remaining[0]!;
          projects.setActiveProjectId(first.id);
          await sessions.refreshSessions(first.id);
        }
      }
    },
    [projects, sessions, chat]
  );

  const onboarding = projects.projectsLoaded && projects.projects.length === 0;

  return (
    <div className="flex h-full bg-slate-950 text-slate-100">
      <Sidebar
        sessions={sessions.sessions}
        activeProject={projects.activeProject}
        activeSessionId={sessions.activeSessionId}
        onNewSession={() => void newSession()}
        onSelect={(id) => void loadSession(id)}
        onRemove={(id) => void removeSession(id)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <Header
          projects={projects.projects}
          activeProject={projects.activeProject}
          providersOpen={providersOpen}
          hasDetectionFailure={providers.hasDetectionFailure}
          onToggleProviders={() => {
            setProvidersOpen((v) => !v);
            setDialog(null);
          }}
          onSelectProject={(id) => void selectProject(id)}
          onNewProject={() => setDialog({ mode: 'create' })}
          onEditProject={() =>
            projects.activeProject && setDialog({ mode: 'edit', project: projects.activeProject })
          }
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

        <ChatView
          items={chat.items}
          busy={chat.busy}
          onboarding={onboarding}
          activeProject={projects.activeProject}
          hasActiveSession={sessions.activeSessionId !== null}
          loadError={loadError}
          onCreateProject={() => setDialog({ mode: 'create' })}
          context={chat.context}
        />
        {chat.context && chat.context.window > 0 && (
          <ContextBar tokens={chat.context.tokens} window={chat.context.window} threshold={chat.context.threshold} />
        )}
        <Composer
          model={chat.modelValue}
          modelGroups={providers.composerProvider(projects.activeProject?.provider_id)?.model_groups ?? []}
          input={chat.input}
          busy={chat.busy}
          disabled={!projects.activeProject}
          placeholder={projects.activeProject ? 'Ask the agent to do something…' : 'Create a project first…'}
          onModelChange={(v) => void chat.setModel(v)}
          onEffortChange={(v) => void chat.setEffort(v)}
          effort={chat.effortValue}
          onInput={chat.setInput}
          onKeyDown={chat.onKeyDown}
          onSend={() => void chat.send()}
          onStop={() => chat.abort()}
        />
      </main>
    </div>
  );
}
