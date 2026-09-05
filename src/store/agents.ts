import fs from 'node:fs';

import type { AgentRegistry, StoredAgent, StoredChannel } from '../types.js';
import { getConfigDb, tryGetConfigDb } from './config-db.js';
import { ensureAgentVarLayout, materializeContext } from './materialize.js';
import { MAIN_AGENT_FOLDER, agentVarDir } from './paths.js';

const FOLDER_RE = /^[A-Za-z0-9._-]+$/;

interface AgentRow {
  folder: string;
  name: string;
  channels: string;
  container_config: string | null;
  heartbeat: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function validateFolder(folder: string): void {
  if (!folder || !FOLDER_RE.test(folder)) {
    throw new Error(
      'invalid folder (allowed: letters, digits, dot, dash, underscore)',
    );
  }
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// The nested registry, rebuilt from the `agents` table. A row whose channels
// map is empty is a folder with nothing wired to it — it still has context,
// var/ state and a display name, so it must survive a round trip.
export function loadRegistry(): AgentRegistry {
  const db = tryGetConfigDb();
  if (!db) return {};
  const rows = db
    .prepare(
      'SELECT folder, name, channels, container_config, heartbeat FROM agents ORDER BY folder',
    )
    .all() as AgentRow[];
  const out: AgentRegistry = {};
  for (const row of rows) {
    const agent: StoredAgent = {
      name: row.name || row.folder,
      channels: parseJson<Record<string, StoredChannel>>(row.channels, {}),
    };
    const heartbeat = parseJson<StoredAgent['heartbeat'] | null>(
      row.heartbeat,
      null,
    );
    if (heartbeat) agent.heartbeat = heartbeat;
    const containerConfig = parseJson<StoredAgent['containerConfig'] | null>(
      row.container_config,
      null,
    );
    if (containerConfig) agent.containerConfig = containerConfig;
    out[row.folder] = agent;
  }
  return out;
}

// Upserts every folder in `reg`. Rows missing from `reg` are left alone:
// unwiring an agent clears its channels, it never drops the row.
export function saveRegistry(reg: AgentRegistry): void {
  const db = getConfigDb();
  const ts = nowIso();
  const stmt = db.prepare(
    `INSERT INTO agents (folder, name, channels, container_config, heartbeat, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(folder) DO UPDATE SET
       name = excluded.name,
       channels = excluded.channels,
       container_config = excluded.container_config,
       heartbeat = excluded.heartbeat,
       updated_at = excluded.updated_at`,
  );
  db.transaction(() => {
    for (const [folder, agent] of Object.entries(reg)) {
      stmt.run(
        folder,
        agent.name ?? folder,
        JSON.stringify(agent.channels ?? {}),
        agent.containerConfig ? JSON.stringify(agent.containerConfig) : null,
        agent.heartbeat ? JSON.stringify(agent.heartbeat) : null,
        ts,
        ts,
      );
    }
  })();
}

export function agentExists(folder: string): boolean {
  const db = tryGetConfigDb();
  if (!db) return false;
  return Boolean(
    db.prepare('SELECT 1 FROM agents WHERE folder = ?').get(folder),
  );
}

export function listAgents(): string[] {
  const db = tryGetConfigDb();
  if (!db) return [];
  return (
    db.prepare('SELECT folder FROM agents ORDER BY folder').all() as {
      folder: string;
    }[]
  ).map((r) => r.folder);
}

export const DEFAULT_IDENTITY = (name: string): string =>
  `# ${name}\n\nDescribe this agent's identity, role, and behaviour here.\n`;

// A new agent is a row plus its agent-scope context. `template` copies the
// template folder's context rows (IDENTITY.md, HEARTBEAT.md, …) verbatim;
// without one the agent gets a stub IDENTITY.md.
export function createAgent(
  folder: string,
  name: string,
  opts: { template?: string } = {},
): void {
  validateFolder(folder);
  if (opts.template) validateFolder(opts.template);
  if (agentExists(folder)) {
    throw new Error(`agent folder already exists: ${folder}`);
  }
  const db = getConfigDb();
  if (opts.template && !agentExists(opts.template)) {
    throw new Error(`template folder not found: ${opts.template}`);
  }
  const ts = nowIso();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO agents (folder, name, channels, container_config, heartbeat, created_at, updated_at)
       VALUES (?, ?, '{}', NULL, NULL, ?, ?)`,
    ).run(folder, name || folder, ts, ts);
    if (opts.template) {
      db.prepare(
        `INSERT INTO context_files (scope, folder, name, content, updated_at)
         SELECT 'agent', ?, name, content, ? FROM context_files
         WHERE scope = 'agent' AND folder = ?`,
      ).run(folder, ts, opts.template);
    } else {
      db.prepare(
        `INSERT INTO context_files (scope, folder, name, content, updated_at)
         VALUES ('agent', ?, 'IDENTITY.md', ?, ?)`,
      ).run(folder, DEFAULT_IDENTITY(name || folder), ts);
    }
  })();
  materializeContext();
  ensureAgentVarLayout(folder);
}

export function deleteAgent(
  folder: string,
  opts: { includeVar?: boolean } = {},
): void {
  validateFolder(folder);
  if (folder === MAIN_AGENT_FOLDER) {
    throw new Error('cannot delete main agent folder');
  }
  const db = getConfigDb();
  db.transaction(() => {
    db.prepare('DELETE FROM agents WHERE folder = ?').run(folder);
    db.prepare(
      "DELETE FROM context_files WHERE scope = 'agent' AND folder = ?",
    ).run(folder);
  })();
  materializeContext();
  if (opts.includeVar) {
    fs.rmSync(agentVarDir(folder), { recursive: true, force: true });
  }
}
