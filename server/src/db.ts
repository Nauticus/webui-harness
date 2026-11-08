import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { DB_PATH } from './paths';

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
  models: string; // JSON ProviderModel[] (legacy: string[]) of detected models
  models_error: string; // last detection error ('' = ok)
  models_checked_at: string | null;
  default_model: string; // '' = auto (first detected model)
  default_reasoning_effort: string; // '' = auto (provider/SDK default)
  created_at: string;
}

/** A detected model plus its configured context window (tokens, optional). */
export interface ProviderModel {
  id: string;
  /** Context window in tokens; unset = unknown (compaction falls back to env/default). */
  contextWindow?: number;
}

/**
 * Parse the providers.models column. Tolerates the legacy plain string[]
 * shape; drops entries without a usable id, keeps contextWindow only when
 * it is a positive number.
 */
export function parseProviderModels(json: string): ProviderModel[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: ProviderModel[] = [];
  for (const e of raw) {
    if (typeof e === 'string' && e.trim()) out.push({ id: e });
    else if (e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string' && (e as { id: string }).id.trim()) {
      const m = e as { id: string; contextWindow?: unknown };
      const cw = typeof m.contextWindow === 'number' && Number.isFinite(m.contextWindow) && m.contextWindow > 0
        ? Math.round(m.contextWindow)
        : undefined;
      out.push(cw === undefined ? { id: m.id } : { id: m.id, contextWindow: cw });
    }
  }
  return out;
}

export interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  model: string; // '' = resolve from project / provider
  reasoning_effort: string; // '' = auto (provider's default)
  created_at: string;
}

// Persistent DB: <dataDir>/weblisan.db (WEBLISAN_DATA_DIR / WEBLISAN_DB to override)
const db = new Database(DB_PATH);
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
    default_model        TEXT NOT NULL DEFAULT '',
    default_reasoning_effort TEXT NOT NULL DEFAULT '',
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
    model      TEXT NOT NULL DEFAULT '',
    reasoning_effort TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Note: message history no longer lives in SQLite; it is stored as encrypted
  -- per-session JSONL files under <dataDir>/history (see src/history.ts).
`);

// Migration for pre-existing databases: add columns introduced after the
// initial schema (guarded so fresh DBs are untouched).
const sessionCols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(
  (c) => c.name
);
if (!sessionCols.includes('reasoning_effort')) {
  db.exec("ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT ''");
}

const providerCols = (db.prepare('PRAGMA table_info(providers)').all() as { name: string }[]).map(
  (c) => c.name
);
if (!providerCols.includes('default_model')) {
  db.exec("ALTER TABLE providers ADD COLUMN default_model TEXT NOT NULL DEFAULT ''");
}
if (!providerCols.includes('default_reasoning_effort')) {
  db.exec("ALTER TABLE providers ADD COLUMN default_reasoning_effort TEXT NOT NULL DEFAULT ''");
}

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
  defaultModel?: string;
  defaultReasoningEffort?: string;
}

const selectProvider = db.prepare(
  'SELECT id, name, base_url, api_key, is_default, models, models_error, models_checked_at, default_model, default_reasoning_effort, created_at FROM providers WHERE id = ?'
);

export function createProvider(input: ProviderInput): ProviderRow {
  const id = randomUUID();
  const name = input.name.trim();
  if (!name) throw new Error('provider name is required');
  const insert = db.prepare(
    'INSERT INTO providers (id, name, base_url, api_key, is_default, default_model, default_reasoning_effort) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const tx = db.transaction(() => {
    if (input.isDefault) {
      db.prepare('UPDATE providers SET is_default = 0').run();
    }
    insert.run(
      id,
      name,
      input.baseUrl ?? '',
      input.apiKey ?? '',
      input.isDefault ? 1 : 0,
      input.defaultModel ?? '',
      input.defaultReasoningEffort ?? ''
    );
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
  patch: {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    isDefault?: boolean;
    defaultModel?: string;
    defaultReasoningEffort?: string;
  }
): ProviderRow | undefined {
  const current = getProvider(id);
  if (!current) return undefined;
  const name = patch.name !== undefined ? patch.name.trim() || current.name : current.name;
  const tx = db.transaction(() => {
    if (patch.isDefault === true) {
      db.prepare('UPDATE providers SET is_default = 0 WHERE id != ?').run(id);
    }
    db.prepare(
      'UPDATE providers SET name = ?, base_url = ?, api_key = ?, is_default = ?, default_model = ?, default_reasoning_effort = ? WHERE id = ?'
    ).run(
      name,
      patch.baseUrl ?? current.base_url,
      patch.apiKey ?? current.api_key,
      patch.isDefault === true ? 1 : patch.isDefault === false ? 0 : current.is_default,
      patch.defaultModel ?? current.default_model,
      patch.defaultReasoningEffort ?? current.default_reasoning_effort,
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
  // Keep user-configured context windows for models that are still detected.
  const existing = new Map(parseProviderModels((selectProvider.get(id) as ProviderRow | undefined)?.models ?? '[]').map((m) => [m.id, m.contextWindow]));
  const models: ProviderModel[] = result.models.map((mid) => {
    const cw = existing.get(mid);
    return cw === undefined ? { id: mid } : { id: mid, contextWindow: cw };
  });
  db.prepare('UPDATE providers SET models = ?, models_error = ?, models_checked_at = datetime(\'now\') WHERE id = ?').run(
    JSON.stringify(models),
    result.error,
    id
  );
}

/**
 * Update per-model context windows. `windows` maps model id -> tokens
 * (null/undefined = clear). Returns the updated model list, or undefined
 * when the provider no longer exists.
 */
export function setModelContextWindows(
  id: string,
  windows: Record<string, number | null | undefined>
): ProviderModel[] | undefined {
  const row = selectProvider.get(id) as ProviderRow | undefined;
  if (!row) return undefined;
  const models = parseProviderModels(row.models).map((m) => {
    const w = windows[m.id];
    if (w === undefined) return m; // not mentioned in this call: leave as is
    if (w === null) return { id: m.id };
    const cw = Number.isFinite(w) && w > 0 ? Math.round(w) : undefined;
    return cw === undefined ? { id: m.id } : { id: m.id, contextWindow: cw };
  });
  db.prepare('UPDATE providers SET models = ? WHERE id = ?').run(JSON.stringify(models), id);
  return models;
}

/* ---------- sessions ---------- */

const selectSession = db.prepare(
  'SELECT id, project_id, title, model, reasoning_effort, created_at FROM sessions WHERE id = ?'
);

export function createSession(
  projectId: string,
  input: { title?: string; model?: string; reasoningEffort?: string } = {}
): SessionRow {
  if (!getProject(projectId)) throw new Error('project not found');
  const id = randomUUID();
  db.prepare('INSERT INTO sessions (id, project_id, title, model, reasoning_effort) VALUES (?, ?, ?, ?, ?)').run(
    id,
    projectId,
    input.title?.trim() || 'New session',
    input.model ?? '',
    input.reasoningEffort ?? ''
  );
  return selectSession.get(id) as SessionRow;
}

export function listSessions(projectId: string): SessionRow[] {
  return db
    .prepare(
      'SELECT id, project_id, title, model, reasoning_effort, created_at FROM sessions WHERE project_id = ? ORDER BY created_at DESC, id DESC'
    )
    .all(projectId) as SessionRow[];
}

export function getSession(id: string): SessionRow | undefined {
  return selectSession.get(id) as SessionRow | undefined;
}

export function setSessionTitle(id: string, title: string): void {
  db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id);
}

export function setSessionModel(id: string, model: string): void {
  db.prepare('UPDATE sessions SET model = ? WHERE id = ?').run(model, id);
}

export function setSessionReasoningEffort(id: string, reasoningEffort: string): void {
  db.prepare('UPDATE sessions SET reasoning_effort = ? WHERE id = ?').run(reasoningEffort, id);
}

export function deleteSession(id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

/* ---------- legacy in-DB message history (one-time migration) ---------- */

export interface LegacyMessageRow {
  session_id: string;
  project_id: string;
  seq: number;
  role: string;
  content: string;
  meta: string | null;
}

/** All rows of the pre-migration `messages` table ([] when it no longer exists). */
export function legacyHistoryRows(): LegacyMessageRow[] {
  try {
    return db
      .prepare(
        `SELECT m.session_id, s.project_id, m.seq, m.role, m.content, m.meta
           FROM messages m
           JOIN sessions s ON s.id = m.session_id
          ORDER BY m.seq ASC`
      )
      .all() as LegacyMessageRow[];
  } catch {
    return [];
  }
}

export function dropLegacyMessages(): void {
  try {
    db.exec('DROP TABLE IF EXISTS messages');
  } catch {
    /* nothing to drop */
  }
}
