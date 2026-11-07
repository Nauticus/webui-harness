import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface ProjectRow {
  id: string;
  name: string;
  cwd: string; // '' = server default (AGENT_WORKSPACE_DIR)
  provider_id: string; // '' = default provider
  model: string; // '' = server default (OPENAI_MODEL)
  created_at: string;
}

export interface ProviderRow {
  id: string;
  name: string;
  base_url: string; // '' = OpenAI official endpoint
  api_key: string;
  is_default: number; // 0 | 1
  models: string; // JSON string[] of detected model ids
  models_error: string; // last detection error ('' = ok)
  models_checked_at: string | null;
  created_at: string;
}

export interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  created_at: string;
}

export interface MessageRow {
  id: number;
  session_id: string;
  seq: number;
  role: string; // 'user' | 'assistant' | 'tool'
  content: string;
  meta: string | null; // JSON: { tool_calls?: OpenAIToolCall[], tool_call_id?: string, name?: string, args?: unknown }
}

export interface AppendMessageInput {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  meta?: Record<string, unknown>;
}

const db = new Database(':memory:');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS providers (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    base_url          TEXT NOT NULL DEFAULT '',
    api_key           TEXT NOT NULL DEFAULT '',
    is_default        INTEGER NOT NULL DEFAULT 0,
    models            TEXT NOT NULL DEFAULT '[]',
    models_error      TEXT NOT NULL DEFAULT '',
    models_checked_at TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    cwd        TEXT NOT NULL DEFAULT '',
    provider_id TEXT NOT NULL DEFAULT '',
    model      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title      TEXT NOT NULL DEFAULT 'New session',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL DEFAULT '',
    meta       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
`);

/* ---------- projects ---------- */

const selectProject = db.prepare(
  'SELECT id, name, cwd, provider_id, model, created_at FROM projects WHERE id = ?'
);

export interface ProjectInput {
  name?: string;
  cwd?: string;
  providerId?: string;
  model?: string;
}

export function createProject(input: ProjectInput = {}): ProjectRow {
  const id = randomUUID();
  const cwd = input.cwd ?? '';
  const fallbackName = cwd ? path.basename(cwd) || 'Project' : 'Project';
  const count = (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
  const name = input.name?.trim() || `${fallbackName} ${count + 1}`.trim();
  db.prepare('INSERT INTO projects (id, name, cwd, provider_id, model) VALUES (?, ?, ?, ?, ?)').run(
    id,
    name,
    cwd,
    input.providerId ?? '',
    input.model ?? ''
  );
  return selectProject.get(id) as ProjectRow;
}

export function listProjects(): ProjectRow[] {
  return db
    .prepare(
      'SELECT id, name, cwd, provider_id, model, created_at FROM projects ORDER BY created_at ASC, id ASC'
    )
    .all() as ProjectRow[];
}

export function getProject(id: string): ProjectRow | undefined {
  return selectProject.get(id) as ProjectRow | undefined;
}

export function updateProject(id: string, patch: ProjectInput): ProjectRow | undefined {
  const current = getProject(id);
  if (!current) return undefined;
  const name = patch.name !== undefined ? patch.name.trim() || current.name : current.name;
  db.prepare('UPDATE projects SET name = ?, cwd = ?, provider_id = ?, model = ? WHERE id = ?').run(
    name,
    patch.cwd ?? current.cwd,
    patch.providerId ?? current.provider_id,
    patch.model ?? current.model,
    id
  );
  return selectProject.get(id) as ProjectRow | undefined;
}

export function deleteProject(id: string): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

/* ---------- providers ---------- */

export interface ProviderInput {
  name: string;
  baseUrl?: string;
  apiKey?: string;
  isDefault?: boolean;
}

const selectProvider = db.prepare(
  'SELECT id, name, base_url, api_key, is_default, models, models_error, models_checked_at, created_at FROM providers WHERE id = ?'
);

export function createProvider(input: ProviderInput): ProviderRow {
  const id = randomUUID();
  const name = input.name.trim();
  if (!name) throw new Error('provider name is required');
  const insert = db.prepare(
    'INSERT INTO providers (id, name, base_url, api_key, is_default) VALUES (?, ?, ?, ?, ?)'
  );
  const tx = db.transaction(() => {
    if (input.isDefault) {
      db.prepare('UPDATE providers SET is_default = 0').run();
    }
    insert.run(id, name, input.baseUrl ?? '', input.apiKey ?? '', input.isDefault ? 1 : 0);
  });
  tx();
  return selectProvider.get(id) as ProviderRow;
}

export interface ProviderWithUsage extends ProviderRow {
  used_by: number;
}

export function listProviders(): ProviderWithUsage[] {
  return db
    .prepare(
      `SELECT p.*, (
         SELECT COUNT(*) FROM projects pr
         WHERE pr.provider_id = p.id OR (pr.provider_id = '' AND p.is_default = 1)
       ) AS used_by
       FROM providers p
       ORDER BY p.is_default DESC, p.created_at ASC, p.id ASC`
    )
    .all() as ProviderWithUsage[];
}

export function getProvider(id: string): ProviderRow | undefined {
  return selectProvider.get(id) as ProviderRow | undefined;
}

export function updateProvider(
  id: string,
  patch: { name?: string; baseUrl?: string; apiKey?: string; isDefault?: boolean }
): ProviderRow | undefined {
  const current = getProvider(id);
  if (!current) return undefined;
  const name = patch.name !== undefined ? patch.name.trim() || current.name : current.name;
  const tx = db.transaction(() => {
    if (patch.isDefault === true) {
      db.prepare('UPDATE providers SET is_default = 0 WHERE id != ?').run(id);
    }
    db.prepare('UPDATE providers SET name = ?, base_url = ?, api_key = ?, is_default = ? WHERE id = ?').run(
      name,
      patch.baseUrl ?? current.base_url,
      patch.apiKey ?? current.api_key,
      patch.isDefault === true ? 1 : patch.isDefault === false ? 0 : current.is_default,
      id
    );
  });
  tx();
  return selectProvider.get(id) as ProviderRow | undefined;
}

export function deleteProvider(id: string): void {
  db.prepare('DELETE FROM providers WHERE id = ?').run(id);
}

export function setProviderModels(
  id: string,
  result: { models: string[]; error: string }
): void {
  db.prepare('UPDATE providers SET models = ?, models_error = ?, models_checked_at = datetime(\'now\') WHERE id = ?').run(
    JSON.stringify(result.models),
    result.error,
    id
  );
}

/* ---------- sessions ---------- */

const selectSession = db.prepare(
  'SELECT id, project_id, title, created_at FROM sessions WHERE id = ?'
);

export function createSession(projectId: string, input: { title?: string } = {}): SessionRow {
  if (!getProject(projectId)) throw new Error('project not found');
  const id = randomUUID();
  db.prepare('INSERT INTO sessions (id, project_id, title) VALUES (?, ?, ?)').run(
    id,
    projectId,
    input.title?.trim() || 'New session'
  );
  return selectSession.get(id) as SessionRow;
}

export function listSessions(projectId: string): SessionRow[] {
  return db
    .prepare(
      'SELECT id, project_id, title, created_at FROM sessions WHERE project_id = ? ORDER BY created_at DESC, id DESC'
    )
    .all(projectId) as SessionRow[];
}

export function getSession(id: string): SessionRow | undefined {
  return selectSession.get(id) as SessionRow | undefined;
}

export function setSessionTitle(id: string, title: string): void {
  db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id);
}

export function deleteSession(id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

/* ---------- messages ---------- */

const nextSeq = db.prepare(`
  INSERT INTO messages (session_id, seq, role, content, meta)
  VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE session_id = ?), ?, ?, ?)
`);

export function getMessages(sessionId: string): MessageRow[] {
  return db
    .prepare('SELECT id, session_id, seq, role, content, meta FROM messages WHERE session_id = ? ORDER BY seq ASC')
    .all(sessionId) as MessageRow[];
}

export function appendMessage(sessionId: string, msg: AppendMessageInput): void {
  nextSeq.run(
    sessionId,
    sessionId,
    msg.role,
    msg.content,
    msg.meta ? JSON.stringify(msg.meta) : null
  );
}
