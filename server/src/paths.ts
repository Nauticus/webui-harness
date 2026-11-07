import path from 'node:path';
import fs from 'node:fs';

/**
 * Base dir for all persistent data: the SQLite DB, session history files and
 * the encryption key. Override with WEBLISAN_DATA_DIR.
 */
export const DATA_DIR = process.env.WEBLISAN_DATA_DIR
  ? path.resolve(process.env.WEBLISAN_DATA_DIR)
  : path.join(import.meta.dirname, '..', '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/** SQLite file. WEBLISAN_DB (fine-grained override) wins over <dataDir>/weblisan.db. */
export const DB_PATH = process.env.WEBLISAN_DB
  ? path.resolve(process.env.WEBLISAN_DB)
  : path.join(DATA_DIR, 'weblisan.db');

/** Session history: <dataDir>/history/<projectId>/<sessionId>.jsonl */
export const HISTORY_DIR = path.join(DATA_DIR, 'history');

/** Auto-generated history encryption key (64 hex chars, mode 600). */
export const KEY_FILE = path.join(DATA_DIR, 'key');
