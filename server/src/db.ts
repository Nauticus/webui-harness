import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface SessionRow {
  id: string;
  title: string;
  created_at: string;
}

export interface MessageRow {
  id: number;
  session_id: string;
  seq: number;
  role: string; // 'user' | 'assistant' | 'tool'
  content: string;
  meta: string | null; // JSON: { tool_calls?: OpenAIToolCall[], tool_call_id?: string, name?: string }
}

export interface AppendMessageInput {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  meta?: Record<string, unknown>;
}

const db = new Database(':memory:');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
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

const nextSeq = db.prepare(`
  INSERT INTO messages (session_id, seq, role, content, meta)
  VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE session_id = ?), ?, ?, ?)
`);

export function createSession(title = 'New session'): SessionRow {
  const id = randomUUID();
  db.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run(id, title);
  return getSession(id)!;
}

export function listSessions(): SessionRow[] {
  return db
    .prepare('SELECT id, title, created_at FROM sessions ORDER BY created_at DESC, id DESC')
    .all() as SessionRow[];
}

export function getSession(id: string): SessionRow | undefined {
  return db.prepare('SELECT id, title, created_at FROM sessions WHERE id = ?').get(id) as
    | SessionRow
    | undefined;
}

export function setSessionTitle(id: string, title: string): void {
  db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id);
}

export function deleteSession(id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

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
