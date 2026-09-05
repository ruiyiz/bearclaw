import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';
import { tryGetConfigDb } from './config-db.js';
import {
  agentVarDir,
  cacheDir,
  contextCacheDir,
  skillsCacheDir,
} from './paths.js';

// The database is the source of truth; var/cache holds read-only copies the
// agent (and the SDK) can open as ordinary files. Nothing here is ever read
// back into the database, so a corrupted mirror is fixed by rebuilding it.

export type MirrorScope = 'shared' | 'agent';

// `home` overrides BEARCLAW_HOME. Only the importer passes it — it can be
// pointed at a tree that is not the running install's.
function contextRoot(home?: string): string {
  return home ? path.join(home, 'var', 'cache', 'context') : contextCacheDir();
}

function mirrorPath(
  scope: MirrorScope,
  folder: string,
  name: string,
  home?: string,
): string {
  const root = contextRoot(home);
  return scope === 'shared'
    ? path.join(root, 'shared', name)
    : path.join(root, 'agents', folder, name);
}

function writeAtomic(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, target);
}

// `content === null` means the row is gone: drop the mirrored copy.
export function materializeContextFile(
  scope: MirrorScope,
  folder: string,
  name: string,
  content: string | null,
): void {
  const target = mirrorPath(scope, folder, name);
  if (content === null) {
    try {
      fs.unlinkSync(target);
    } catch {
      // already absent
    }
    return;
  }
  writeAtomic(target, content);
}

function listMirroredFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
}

// Full rebuild: write every row, then delete mirrored files with no row behind
// them (a rename or delete that happened while the process was down).
export function materializeContext(home?: string): void {
  const db = tryGetConfigDb();
  if (!db) return;
  const rows = db
    .prepare('SELECT scope, folder, name, content FROM context_files')
    .all() as {
    scope: MirrorScope;
    folder: string;
    name: string;
    content: string;
  }[];

  const wanted = new Map<string, string>();
  for (const row of rows) {
    wanted.set(mirrorPath(row.scope, row.folder, row.name, home), row.content);
  }

  const root = contextRoot(home);
  const sharedDir = path.join(root, 'shared');
  const agentsDir = path.join(root, 'agents');
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });

  for (const [target, content] of wanted) writeAtomic(target, content);

  const existing = [...listMirroredFiles(sharedDir)];
  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    existing.push(...listMirroredFiles(path.join(agentsDir, entry.name)));
  }
  for (const file of existing) {
    if (wanted.has(file)) continue;
    try {
      fs.unlinkSync(file);
    } catch {
      // best effort
    }
  }
}

function skillsRoot(home?: string): string {
  return home ? path.join(home, 'var', 'cache', 'skills') : skillsCacheDir();
}

// Full rebuild into a sibling temp tree, then an atomic-ish swap. A reader that
// opened a file keeps its handle; the next open sees the new tree. With no
// skills at all the directory still has to exist, or the per-agent symlink
// dangles and the SDK refuses to walk it.
export function materializeSkills(home?: string): void {
  const root = skillsRoot(home);
  const tmp = `${root}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  const db = tryGetConfigDb();
  const rows = db
    ? (db
        .prepare(
          'SELECT skill, relpath, content, mode FROM skill_files ORDER BY skill, relpath',
        )
        .all() as {
        skill: string;
        relpath: string;
        content: Buffer;
        mode: number;
      }[])
    : [];

  try {
    for (const row of rows) {
      const target = path.join(tmp, row.skill, ...row.relpath.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, row.content);
      fs.chmodSync(target, row.mode & 0o777);
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.renameSync(tmp, root);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    logger.warn({ err, root }, 'could not rebuild the skills mirror');
    fs.mkdirSync(root, { recursive: true });
  }
}

function ensureSymlink(link: string, target: string): void {
  let current: fs.Stats | null = null;
  try {
    current = fs.lstatSync(link);
  } catch {
    current = null;
  }
  if (current?.isSymbolicLink()) {
    if (fs.readlinkSync(link) === target) return;
    fs.unlinkSync(link);
  } else if (current) {
    logger.warn(
      { link },
      'expected a symlink into var/cache but found a real path — leaving it alone',
    );
    return;
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.symlinkSync(target, link);
  } catch (err) {
    logger.warn({ err, link, target }, 'could not create mirror symlink');
  }
}

// The agent's cwd. `context/` and `.claude/skills` are symlinks into the
// shared mirror so every agent sees the same regenerated copies, and the SDK
// discovers skills from the cwd rather than from ~/.bearclaw.
export function ensureAgentVarLayout(folder: string): void {
  const dir = agentVarDir(folder);
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.mkdirSync(contextCacheDir(), { recursive: true });
  fs.mkdirSync(skillsCacheDir(), { recursive: true });
  ensureSymlink(path.join(dir, 'context'), '../../cache/context');
  ensureSymlink(path.join(dir, '.claude', 'skills'), '../../../cache/skills');
}

export function materializeAll(home?: string): void {
  const cache = home ? path.join(home, 'var', 'cache') : cacheDir();
  fs.mkdirSync(cache, { recursive: true });
  materializeSkills(home);
  materializeContext(home);
}
