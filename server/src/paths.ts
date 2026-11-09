import path from 'node:path';
import fs from 'node:fs';

/**
 * Base dir for all persistent data: the SQLite DB, session history files and
 * the encryption key. Override with WEBUI_H_DATA_DIR.
 */
export const DATA_DIR = process.env.WEBUI_H_DATA_DIR
  ? path.resolve(process.env.WEBUI_H_DATA_DIR)
  : path.join(import.meta.dirname, '..', '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/** SQLite file. WEBUI_H_DB (fine-grained override) wins over <dataDir>/webui-h.db. */
export const DB_PATH = ((): string => {
  if (process.env.WEBUI_H_DB) return path.resolve(process.env.WEBUI_H_DB);
  const current = path.join(DATA_DIR, 'webui-h.db');
  // Fallback for installs predating the rename to webui-h: their data still
  // lives in weblisan.db. Keep reading it until webui-h.db exists, otherwise
  // the rename would silently present an empty database. Drop this once every
  // install has been migrated (see README).
  const legacy = path.join(DATA_DIR, 'weblisan.db');
  if (!fs.existsSync(current) && fs.existsSync(legacy)) return legacy;
  return current;
})();

/** Session history: <dataDir>/history/<projectId>/<sessionId>.jsonl */
export const HISTORY_DIR = path.join(DATA_DIR, 'history');

/** Auto-generated history encryption key (64 hex chars, mode 600). */
export const KEY_FILE = path.join(DATA_DIR, 'key');
