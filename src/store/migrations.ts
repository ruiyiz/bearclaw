import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  up(db: Database.Database): void;
}

const V1 = `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  secret INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE agents (
  folder TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  channels TEXT NOT NULL DEFAULT '{}',
  container_config TEXT,
  heartbeat TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE context_files (
  scope TEXT NOT NULL CHECK (scope IN ('shared','agent')),
  folder TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, folder, name)
);

CREATE TABLE skills (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  source_path TEXT,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE skill_files (
  skill TEXT NOT NULL REFERENCES skills(name) ON DELETE CASCADE,
  relpath TEXT NOT NULL,
  content BLOB NOT NULL,
  mode INTEGER NOT NULL DEFAULT 420,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (skill, relpath)
);

CREATE TABLE skill_sources (
  dir TEXT PRIMARY KEY,
  added_at TEXT NOT NULL
);

CREATE TABLE mcp_servers (
  name TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE model_catalog (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  catalog TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workflow_definitions (
  slug TEXT PRIMARY KEY,
  definition TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(V1);
    },
  },
];

export const LATEST_VERSION = MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  0,
);

export function schemaVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

// Forward-only. A database stamped past LATEST_VERSION was written by a newer
// build; running the old code against it would silently misread rows.
export function runMigrations(db: Database.Database): number {
  const current = schemaVersion(db);
  if (current > LATEST_VERSION) {
    throw new Error(
      `bearclaw.db schema is v${current} but this build only knows v${LATEST_VERSION}. Upgrade BearClaw.`,
    );
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
  return schemaVersion(db);
}
