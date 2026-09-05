import path from 'node:path';

import { agentExists, listAgents } from './agents.js';
import { getConfigDb, tryGetConfigDb } from './config-db.js';
import { materializeContextFile } from './materialize.js';
import { contextCacheDir } from './paths.js';

export type ContextScope = 'shared' | 'agent';

export interface ContextFile {
  scope: ContextScope;
  folder: string | null; // null for shared
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
}

export interface ContextListing {
  shared: ContextFile[];
  agents: Array<{ folder: string; files: ContextFile[] }>;
}

// Widened past .md so workflow prompt templates (.hbs, .txt, .html, .json)
// live in the same store as the context documents.
const NAME_RE = /^[A-Za-z0-9._-]+\.(md|txt|html|hbs|json)$/;
const FOLDER_RE = /^[A-Za-z0-9._-]+$/;

// A (scope, folder, name) triple that names no row. Callers distinguish it
// from a validation failure: the HTTP layer answers 404 for this one and 400
// for everything else.
export class ContextFileNotFound extends Error {
  constructor() {
    super('file not found');
    this.name = 'ContextFileNotFound';
  }
}

interface Row {
  scope: ContextScope;
  folder: string;
  name: string;
  content: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

// Where the read-only mirror of this row lands, so the UI (and the agent) can
// name a real file path.
export function contextFilePath(
  scope: ContextScope,
  folder: string | null,
  name: string,
): string {
  const root = contextCacheDir();
  return scope === 'shared'
    ? path.join(root, 'shared', name)
    : path.join(root, 'agents', folder ?? '', name);
}

// Validates and normalizes a (scope, folder, name) triple into row keys.
// Shared rows carry the empty string as their folder, matching the schema.
function resolveKey(
  scope: ContextScope,
  folder: string | null,
  name: string,
): { scope: ContextScope; folder: string; name: string } {
  if (!NAME_RE.test(name)) throw new Error('invalid filename');
  if (scope === 'shared') return { scope, folder: '', name };
  if (!folder || !FOLDER_RE.test(folder)) throw new Error('invalid folder');
  if (!agentExists(folder)) throw new Error('agent folder not found');
  return { scope, folder, name };
}

function toContextFile(row: Row): ContextFile {
  const folder = row.scope === 'shared' ? null : row.folder;
  return {
    scope: row.scope,
    folder,
    name: row.name,
    path: contextFilePath(row.scope, folder, row.name),
    size: Buffer.byteLength(row.content, 'utf-8'),
    modifiedAt: row.updated_at,
  };
}

export function listContextFiles(): ContextListing {
  const db = tryGetConfigDb();
  if (!db) return { shared: [], agents: [] };
  const rows = db
    .prepare(
      'SELECT scope, folder, name, content, updated_at FROM context_files ORDER BY folder, name',
    )
    .all() as Row[];

  const shared = rows
    .filter((r) => r.scope === 'shared')
    .map(toContextFile)
    .sort((a, b) => a.name.localeCompare(b.name));

  const byFolder = new Map<string, ContextFile[]>();
  // Registered folders show up even with no context of their own, matching
  // the old listing of every directory under ~/.bearclaw/agents.
  for (const folder of listAgents()) byFolder.set(folder, []);
  for (const row of rows) {
    if (row.scope !== 'agent') continue;
    const files = byFolder.get(row.folder) ?? [];
    files.push(toContextFile(row));
    byFolder.set(row.folder, files);
  }

  const agents = [...byFolder.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([folder, files]) => ({
      folder,
      files: files.sort((a, b) => a.name.localeCompare(b.name)),
    }));

  return { shared, agents };
}

// Raw content, no validation error when the row is missing — for the prompt
// builders, which treat an absent file as an empty section.
export function getContextFile(
  scope: ContextScope,
  folder: string | null,
  name: string,
): string | undefined {
  const db = tryGetConfigDb();
  if (!db) return undefined;
  const row = db
    .prepare(
      'SELECT content FROM context_files WHERE scope = ? AND folder = ? AND name = ?',
    )
    .get(scope, scope === 'shared' ? '' : (folder ?? ''), name) as
    | { content: string }
    | undefined;
  return row?.content;
}

export function readContextFile(
  scope: ContextScope,
  folder: string | null,
  name: string,
): { content: string; modifiedAt: string } {
  const key = resolveKey(scope, folder, name);
  const row = getConfigDb()
    .prepare(
      'SELECT content, updated_at FROM context_files WHERE scope = ? AND folder = ? AND name = ?',
    )
    .get(key.scope, key.folder, key.name) as
    | { content: string; updated_at: string }
    | undefined;
  if (!row) throw new ContextFileNotFound();
  return { content: row.content, modifiedAt: row.updated_at };
}

export function writeContextFile(
  scope: ContextScope,
  folder: string | null,
  name: string,
  content: string,
): { modifiedAt: string } {
  const key = resolveKey(scope, folder, name);
  const ts = nowIso();
  getConfigDb()
    .prepare(
      `INSERT INTO context_files (scope, folder, name, content, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope, folder, name) DO UPDATE SET
         content = excluded.content,
         updated_at = excluded.updated_at`,
    )
    .run(key.scope, key.folder, key.name, content, ts);
  materializeContextFile(key.scope, key.folder, key.name, content);
  return { modifiedAt: ts };
}

export function createContextFile(
  scope: ContextScope,
  folder: string | null,
  name: string,
  content = '',
): { modifiedAt: string } {
  const key = resolveKey(scope, folder, name);
  const exists = getConfigDb()
    .prepare(
      'SELECT 1 FROM context_files WHERE scope = ? AND folder = ? AND name = ?',
    )
    .get(key.scope, key.folder, key.name);
  if (exists) throw new Error('file already exists');
  return writeContextFile(scope, folder, name, content);
}

export function deleteContextFile(
  scope: ContextScope,
  folder: string | null,
  name: string,
): void {
  const key = resolveKey(scope, folder, name);
  const info = getConfigDb()
    .prepare(
      'DELETE FROM context_files WHERE scope = ? AND folder = ? AND name = ?',
    )
    .run(key.scope, key.folder, key.name);
  if (info.changes === 0) throw new ContextFileNotFound();
  materializeContextFile(key.scope, key.folder, key.name, null);
}
