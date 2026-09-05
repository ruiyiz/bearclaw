import fs from 'node:fs';
import path from 'node:path';

import { getConfigDb, tryGetConfigDb } from './config-db.js';
import { materializeSkills } from './materialize.js';
import { skillsCacheDir } from './paths.js';

// Skills live in the database; var/cache/skills is a regenerated mirror the
// Agent SDK discovers through each agent's .claude/skills symlink. Every
// mutation here rebuilds that mirror.

export interface SkillRecord {
  name: string;
  description: string;
  sourcePath: string | null;
  installedAt: string;
  updatedAt: string;
}

export interface SkillFileInfo {
  relpath: string;
  mode: number;
  size: number;
  updatedAt: string;
}

const NAME_RE = /^[A-Za-z0-9._-]+$/;

interface SkillRow {
  name: string;
  description: string;
  source_path: string | null;
  installed_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function parseSkillDescription(content: string): string {
  const lines = content.split('\n');
  for (const line of lines) {
    const match = line.match(/^description:\s*(.+)/i);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
      return trimmed.slice(0, 80);
    }
  }
  return '';
}

export function validateSkillName(name: string): void {
  if (!name || !NAME_RE.test(name) || name === '.' || name === '..') {
    throw new Error(
      'invalid skill name (allowed: letters, digits, dot, dash, underscore)',
    );
  }
}

// Relative POSIX paths only: the mirror joins these onto the cache directory,
// so anything that could escape it is rejected.
export function validateRelpath(relpath: string): void {
  if (!relpath) throw new Error('invalid path');
  if (relpath.includes('\\')) throw new Error('invalid path');
  if (relpath.startsWith('/')) throw new Error('invalid path');
  if (path.posix.isAbsolute(relpath) || path.win32.isAbsolute(relpath))
    throw new Error('invalid path');
  const segments = relpath.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..')
      throw new Error('invalid path');
    if (segment.includes('\0')) throw new Error('invalid path');
  }
}

function toRecord(row: SkillRow): SkillRecord {
  return {
    name: row.name,
    description: row.description,
    sourcePath: row.source_path,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}

export function listSkills(): SkillRecord[] {
  const db = tryGetConfigDb();
  if (!db) return [];
  const rows = db
    .prepare(
      'SELECT name, description, source_path, installed_at, updated_at FROM skills ORDER BY name',
    )
    .all() as SkillRow[];
  return rows.map(toRecord);
}

export function getSkill(name: string): SkillRecord | undefined {
  const db = tryGetConfigDb();
  if (!db) return undefined;
  const row = db
    .prepare(
      'SELECT name, description, source_path, installed_at, updated_at FROM skills WHERE name = ?',
    )
    .get(name) as SkillRow | undefined;
  return row ? toRecord(row) : undefined;
}

export function listSkillFiles(name: string): SkillFileInfo[] {
  const db = tryGetConfigDb();
  if (!db) return [];
  const rows = db
    .prepare(
      'SELECT relpath, mode, length(content) AS size, updated_at FROM skill_files WHERE skill = ? ORDER BY relpath',
    )
    .all(name) as {
    relpath: string;
    mode: number;
    size: number;
    updated_at: string;
  }[];
  return rows.map((r) => ({
    relpath: r.relpath,
    mode: r.mode,
    size: r.size,
    updatedAt: r.updated_at,
  }));
}

export function getSkillFile(
  name: string,
  relpath: string,
): { content: Buffer; mode: number; updatedAt: string } | undefined {
  const db = tryGetConfigDb();
  if (!db) return undefined;
  const row = db
    .prepare(
      'SELECT content, mode, updated_at FROM skill_files WHERE skill = ? AND relpath = ?',
    )
    .get(name, relpath) as
    | { content: Buffer; mode: number; updated_at: string }
    | undefined;
  if (!row) return undefined;
  return {
    content: Buffer.from(row.content),
    mode: row.mode,
    updatedAt: row.updated_at,
  };
}

function requireSkill(name: string): void {
  const exists = getConfigDb()
    .prepare('SELECT 1 FROM skills WHERE name = ?')
    .get(name);
  if (!exists) throw new Error('skill not found');
}

export function putSkillFile(
  name: string,
  relpath: string,
  content: Buffer | string,
  mode?: number,
): { updatedAt: string } {
  validateSkillName(name);
  validateRelpath(relpath);
  const db = getConfigDb();
  requireSkill(name);
  const blob = Buffer.isBuffer(content)
    ? content
    : Buffer.from(content, 'utf-8');
  const existing = db
    .prepare('SELECT mode FROM skill_files WHERE skill = ? AND relpath = ?')
    .get(name, relpath) as { mode: number } | undefined;
  const finalMode = mode ?? existing?.mode ?? 0o644;
  const ts = nowIso();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO skill_files (skill, relpath, content, mode, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(skill, relpath) DO UPDATE SET
         content = excluded.content,
         mode = excluded.mode,
         updated_at = excluded.updated_at`,
    ).run(name, relpath, blob, finalMode, ts);
    if (relpath === 'SKILL.md') {
      db.prepare(
        'UPDATE skills SET description = ?, updated_at = ? WHERE name = ?',
      ).run(parseSkillDescription(blob.toString('utf-8')), ts, name);
    } else {
      db.prepare('UPDATE skills SET updated_at = ? WHERE name = ?').run(
        ts,
        name,
      );
    }
  })();
  materializeSkills();
  return { updatedAt: ts };
}

export function deleteSkillFile(name: string, relpath: string): void {
  validateSkillName(name);
  validateRelpath(relpath);
  const db = getConfigDb();
  const info = db
    .prepare('DELETE FROM skill_files WHERE skill = ? AND relpath = ?')
    .run(name, relpath);
  if (info.changes === 0) throw new Error('file not found');
  db.prepare('UPDATE skills SET updated_at = ? WHERE name = ?').run(
    nowIso(),
    name,
  );
  materializeSkills();
}

export interface WalkedFile {
  relpath: string;
  abs: string;
  mode: number;
}

// Dot-entries and symlinks are skipped: the first are editor and settings
// debris, the second cannot be reproduced faithfully in the mirror.
export function walkSkillDir(root: string, rel = ''): WalkedFile[] {
  const out: WalkedFile[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) continue;
    const childRel = rel ? path.posix.join(rel, entry.name) : entry.name;
    const abs = path.join(root, childRel);
    if (entry.isDirectory()) {
      out.push(...walkSkillDir(root, childRel));
    } else if (entry.isFile()) {
      out.push({ relpath: childRel, abs, mode: fs.statSync(abs).mode & 0o777 });
    }
  }
  return out;
}

// Replaces every file of `name` with what is on disk at `srcDir`, in one
// transaction. Re-importing an installed skill is how "sync from source" works.
export function importSkillDir(
  srcDir: string,
  name: string,
  sourcePath?: string,
): { name: string; files: number } {
  validateSkillName(name);
  const files = walkSkillDir(srcDir);
  if (!files.some((f) => f.relpath === 'SKILL.md'))
    throw new Error(`no SKILL.md in ${srcDir}`);

  const db = getConfigDb();
  const ts = nowIso();
  const skillMd = files.find((f) => f.relpath === 'SKILL.md');
  const description = parseSkillDescription(
    fs.readFileSync(skillMd!.abs, 'utf-8'),
  );
  const contents = files.map((f) => ({ ...f, data: fs.readFileSync(f.abs) }));

  db.transaction(() => {
    const existing = db
      .prepare('SELECT installed_at, source_path FROM skills WHERE name = ?')
      .get(name) as
      | { installed_at: string; source_path: string | null }
      | undefined;
    db.prepare(
      `INSERT INTO skills (name, description, source_path, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         description = excluded.description,
         source_path = excluded.source_path,
         updated_at = excluded.updated_at`,
    ).run(
      name,
      description,
      sourcePath ?? existing?.source_path ?? null,
      existing?.installed_at ?? ts,
      ts,
    );
    db.prepare('DELETE FROM skill_files WHERE skill = ?').run(name);
    const stmt = db.prepare(
      `INSERT INTO skill_files (skill, relpath, content, mode, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const file of contents)
      stmt.run(name, file.relpath, file.data, file.mode, ts);
  })();

  materializeSkills();
  return { name, files: contents.length };
}

export function removeSkill(name: string): void {
  const db = getConfigDb();
  db.prepare('DELETE FROM skills WHERE name = ?').run(name);
  materializeSkills();
}

export function listSkillSources(): string[] {
  const db = tryGetConfigDb();
  if (!db) return [];
  const rows = db
    .prepare('SELECT dir FROM skill_sources ORDER BY dir')
    .all() as { dir: string }[];
  return rows.map((r) => r.dir);
}

export function addSkillSource(dir: string): void {
  if (!dir) throw new Error('missing dir');
  getConfigDb()
    .prepare(
      'INSERT OR IGNORE INTO skill_sources (dir, added_at) VALUES (?, ?)',
    )
    .run(dir, nowIso());
}

export function removeSkillSource(dir: string): void {
  getConfigDb().prepare('DELETE FROM skill_sources WHERE dir = ?').run(dir);
}

// The mirrored location of a file, for UIs that want to name a real path.
export function skillMirrorPath(name: string, relpath = 'SKILL.md'): string {
  return path.join(skillsCacheDir(), name, relpath);
}
