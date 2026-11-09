/** A detected model plus its configured context window (tokens, optional). */
export interface ProviderModel {
  id: string;
  contextWindow?: number;
}

/**
 * A base model with its detected aliases collapsed in (dated snapshots like
 * gpt-4o-2024-11-20, OpenRouter service variants like openai/gpt-4o:free).
 * `id` is the canonical model id to send to the provider.
 */
export interface ModelGroup {
  id: string;
  aliases: string[];
  contextWindow?: number;
}

export interface Provider {
  id: string;
  name: string;
  base_url: string; // '' = OpenAI official endpoint
  api_key: string; // masked ('•••') when set
  is_default: boolean;
  models: ProviderModel[]; // detected models (+ configured context windows)
  model_groups: ModelGroup[]; // models collapsed into base models (alias groups)
  models_error: string; // '' = detection ok
  models_checked_at: string | null;
  default_model: string; // '' = auto (first detected model)
  default_reasoning_effort: string; // '' = auto (provider/SDK default)
  used_by: number; // projects using this provider
  created_at: string;
}

export interface ProviderInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  isDefault?: boolean;
  /** Per-model context windows (tokens); null = clear. Applied on update. */
  modelContextWindows?: Record<string, number | null>;
  /** Provider's default model; '' = auto (first detected model). */
  defaultModel?: string;
  /** Provider's default reasoning effort; '' = auto. */
  defaultReasoningEffort?: string;
}

export interface Project {
  id: string;
  name: string;
  cwd: string; // '' = server default (AGENT_WORKSPACE_DIR)
  provider_id: string; // '' = default provider
  model: string; // '' = server default (OPENAI_MODEL)
  created_at: string;
}

export interface Session {
  id: string;
  project_id: string;
  title: string;
  model: string; // '' = resolve from project / provider
  reasoning_effort: string; // '' = auto (provider's default)
  created_at: string;
}

export interface ToolCallInfo {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface MessageRow {
  id: number;
  session_id: string;
  seq: number;
  role: string;
  content: string;
  meta: string | null;
}

/** Last-known context size vs the model's window and compaction threshold. */
export interface ContextUsage {
  tokens: number;
  window: number;
  threshold: number;
}

/** Agent Skill (agentskills.io spec): a directory with SKILL.md. */
export interface Skill {
  name: string;
  description: string;
  dir: string;
  filePath: string;
  source: 'global' | 'project';
  disableModelInvocation: boolean;
}

export interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

export interface DirsResponse {
  path: string;
  parent: string;
  dirs: string[];
}

/** One entry of a project's working directory, addressed relative to it. */
export interface FileEntry {
  path: string;
  type: 'file' | 'dir';
}

export interface FilesResponse {
  /** Absolute root the entries are relative to (for display only). */
  root: string;
  /** The directory listed; '' when the response is a recursive search. */
  dir: string;
  entries: FileEntry[];
  /** There were more matches than the list shows. */
  truncated: boolean;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface ProjectInput {
  name?: string;
  cwd?: string;
  providerId?: string;
  model?: string;
}

export const api = {
  listProviders: () => fetch('/api/providers').then((r) => json<Provider[]>(r)),
  createProvider: (input: ProviderInput) =>
    fetch('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => json<Provider>(r)),
  updateProvider: (id: string, patch: ProviderInput) =>
    fetch(`/api/providers/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<Provider>(r)),
  deleteProvider: (id: string) =>
    fetch(`/api/providers/${id}`, { method: 'DELETE' }).then((r) => json<void>(r)),
  detectProvider: (id: string) =>
    fetch(`/api/providers/${id}/detect`, { method: 'POST' }).then((r) => json<Provider>(r)),

  listProjects: () => fetch('/api/projects').then((r) => json<Project[]>(r)),
  createProject: (input: ProjectInput) =>
    fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => json<Project>(r)),
  updateProject: (id: string, patch: ProjectInput) =>
    fetch(`/api/projects/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<Project>(r)),
  deleteProject: (id: string) =>
    fetch(`/api/projects/${id}`, { method: 'DELETE' }).then((r) => json<void>(r)),

  listSessions: (projectId: string) =>
    fetch(`/api/sessions?projectId=${encodeURIComponent(projectId)}`).then((r) => json<Session[]>(r)),
  createSession: (projectId: string, model?: string, reasoningEffort?: string) =>
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      }),
    }).then((r) => json<Session>(r)),
  updateSessionModel: (id: string, model: string) =>
    fetch(`/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    }).then((r) => json<Session>(r)),
  updateSessionReasoningEffort: (id: string, reasoningEffort: string) =>
    fetch(`/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reasoningEffort }),
    }).then((r) => json<Session>(r)),
  deleteSession: (id: string) => fetch(`/api/sessions/${id}`, { method: 'DELETE' }).then((r) => json<void>(r)),
  listSkills: (projectId?: string) =>
    fetch(`/api/skills${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`).then((r) =>
      json<{ skills: Skill[] }>(r)
    ),
  getSession: (id: string) =>
    fetch(`/api/sessions/${id}`).then((r) =>
      json<{ session: Session; context: ContextUsage | null; messages: MessageRow[] }>(r)
    ),
  listDirs: (p?: string) =>
    fetch(`/api/dirs${p ? `?path=${encodeURIComponent(p)}` : ''}`).then((r) => json<DirsResponse>(r)),
  /**
   * Files inside a project's working directory — the `@` picker's data.
   * A `q` searches the whole tree by path; without it, `dir` is listed.
   */
  listFiles: (opts: { projectId?: string; q?: string; dir?: string }) => {
    const ps = new URLSearchParams();
    if (opts.projectId) ps.set('projectId', opts.projectId);
    if (opts.q) ps.set('q', opts.q);
    if (opts.dir) ps.set('dir', opts.dir);
    const qs = ps.toString();
    return fetch(`/api/files${qs ? `?${qs}` : ''}`).then((r) => json<FilesResponse>(r));
  },
};

/**
 * POST a user message and consume the SSE stream of agent events.
 */
export async function streamTurn(
  sessionId: string,
  content: string,
  onEvent: (ev: ServerEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
    signal,
  });
  await readSse(res, onEvent);
}

/**
 * Summarize the session's older messages now, rather than waiting for the next
 * turn to trip the compaction threshold. Streams compaction events, then a
 * refreshed `context`.
 */
export async function streamCompact(
  sessionId: string,
  onEvent: (ev: ServerEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/compact`, { method: 'POST', signal });
  await readSse(res, onEvent);
}

/** Consume an SSE response, dispatching each `data:` block as an event. */
async function readSse(res: Response, onEvent: (ev: ServerEvent) => void): Promise<void> {
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split('\n\n');
    buf = blocks.pop() ?? '';
    for (const block of blocks) {
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('');
      if (data) onEvent(JSON.parse(data) as ServerEvent);
    }
  }
}
