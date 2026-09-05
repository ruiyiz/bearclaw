import { getConfigDb, tryGetConfigDb } from './config-db.js';

// MCP server definitions. Values keep their ${VAR} placeholders verbatim;
// src/agent/mcp-config.ts expands them against the environment at load time.

export interface McpServerRow {
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  updatedAt: string;
}

interface RawRow {
  name: string;
  config: string;
  enabled: number;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toRow(raw: RawRow): McpServerRow {
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw.config) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      config = parsed as Record<string, unknown>;
  } catch {
    // A row that is not an object is unusable; report it as an empty server.
  }
  return {
    name: raw.name,
    config,
    enabled: raw.enabled === 1,
    updatedAt: raw.updated_at,
  };
}

export function listMcpServers(): McpServerRow[] {
  const db = tryGetConfigDb();
  if (!db) return [];
  return (
    db
      .prepare(
        'SELECT name, config, enabled, updated_at FROM mcp_servers ORDER BY name',
      )
      .all() as RawRow[]
  ).map(toRow);
}

export function getMcpServer(name: string): McpServerRow | undefined {
  const db = tryGetConfigDb();
  if (!db) return undefined;
  const row = db
    .prepare(
      'SELECT name, config, enabled, updated_at FROM mcp_servers WHERE name = ?',
    )
    .get(name) as RawRow | undefined;
  return row ? toRow(row) : undefined;
}

export function putMcpServer(
  name: string,
  config: Record<string, unknown>,
  opts: { enabled?: boolean } = {},
): McpServerRow {
  const enabled = opts.enabled ?? true;
  const updatedAt = nowIso();
  getConfigDb()
    .prepare(
      `INSERT INTO mcp_servers (name, config, enabled, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         config = excluded.config,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    )
    .run(name, JSON.stringify(config), enabled ? 1 : 0, updatedAt);
  return { name, config, enabled, updatedAt };
}

export function deleteMcpServer(name: string): boolean {
  const db = tryGetConfigDb();
  if (!db) return false;
  return (
    db.prepare('DELETE FROM mcp_servers WHERE name = ?').run(name).changes > 0
  );
}

export function setMcpServerEnabled(name: string, enabled: boolean): boolean {
  const db = tryGetConfigDb();
  if (!db) return false;
  return (
    db
      .prepare(
        'UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE name = ?',
      )
      .run(enabled ? 1 : 0, nowIso(), name).changes > 0
  );
}
