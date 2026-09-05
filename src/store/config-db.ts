import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { runMigrations } from './migrations.js';
import { CONFIG_DB_PATH } from './paths.js';

let db: Database.Database | null = null;
let openPath: string | null = null;

// One connection per process. `dbPath` is injectable so tests can run the real
// schema against ':memory:' instead of the operator's database.
export function initConfigDb(dbPath = CONFIG_DB_PATH): Database.Database {
  if (db && openPath === dbPath) return db;
  if (db) {
    db.close();
    db = null;
    openPath = null;
  }
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const next = new Database(dbPath);
  // DELETE keeps the config DB a single file, so export/import and backups do
  // not have to reason about -wal/-shm siblings.
  next.pragma('journal_mode = DELETE');
  next.pragma('foreign_keys = ON');
  next.pragma('busy_timeout = 5000');
  runMigrations(next);
  if (dbPath !== ':memory:') {
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // best effort — the file holds secrets but an unwritable mode is not fatal
    }
  }
  db = next;
  openPath = dbPath;
  return db;
}

export function getConfigDb(): Database.Database {
  if (!db) {
    throw new Error('config db is not open — call bootstrap() first');
  }
  return db;
}

export function tryGetConfigDb(): Database.Database | null {
  return db;
}

export function configDbPath(): string | null {
  return openPath;
}

export function closeConfigDb(): void {
  if (!db) return;
  db.close();
  db = null;
  openPath = null;
}
