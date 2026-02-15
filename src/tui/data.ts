import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

import { STORE_DIR, GROUPS_DIR, DATA_DIR } from '../config.js';
import { loadJson } from '../utils.js';
import type {
  EventRecord,
  Handler,
  HandlerRunLog,
  RegisteredGroup,
} from '../types.js';

const DB_PATH = path.join(STORE_DIR, 'messages.db');

function openDb(readonly = true): Database.Database {
  return new Database(DB_PATH, { readonly });
}

// ─── Events ─────────────────────────────────────────────────────────────────

export function getRecentEvents(limit = 200): EventRecord[] {
  const db = openDb();
  try {
    return db
      .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
      .all(limit) as EventRecord[];
  } finally {
    db.close();
  }
}

export function getEventsByType(type: string, limit = 200): EventRecord[] {
  const db = openDb();
  try {
    return db
      .prepare('SELECT * FROM events WHERE type LIKE ? ORDER BY id DESC LIMIT ?')
      .all(`%${type}%`, limit) as EventRecord[];
  } finally {
    db.close();
  }
}

// ─── Handlers ───────────────────────────────────────────────────────────────

export function getAllHandlers(): Handler[] {
  const db = openDb();
  try {
    return db
      .prepare('SELECT * FROM handlers ORDER BY created_at DESC')
      .all() as Handler[];
  } finally {
    db.close();
  }
}

export function pauseHandler(id: string): void {
  const db = openDb(false);
  try {
    db.prepare("UPDATE handlers SET status = 'paused' WHERE id = ?").run(id);
  } finally {
    db.close();
  }
}

export function resumeHandler(id: string): void {
  const db = openDb(false);
  try {
    db.prepare("UPDATE handlers SET status = 'active' WHERE id = ?").run(id);
  } finally {
    db.close();
  }
}

export function deleteHandler(id: string): void {
  const db = openDb(false);
  try {
    db.prepare('DELETE FROM handler_logs WHERE handler_id = ?').run(id);
    db.prepare('DELETE FROM handlers WHERE id = ?').run(id);
  } finally {
    db.close();
  }
}

// ─── Handler Logs ───────────────────────────────────────────────────────────

export function getHandlerLogs(
  handlerId: string,
  limit = 50,
): HandlerRunLog[] {
  const db = openDb();
  try {
    return db
      .prepare(
        'SELECT * FROM handler_logs WHERE handler_id = ? ORDER BY run_at DESC LIMIT ?',
      )
      .all(handlerId, limit) as HandlerRunLog[];
  } finally {
    db.close();
  }
}

export function getRecentHandlerLogs(limit = 100): HandlerRunLog[] {
  const db = openDb();
  try {
    return db
      .prepare('SELECT * FROM handler_logs ORDER BY run_at DESC LIMIT ?')
      .all(limit) as HandlerRunLog[];
  } finally {
    db.close();
  }
}

// ─── Groups ─────────────────────────────────────────────────────────────────

export function getRegisteredGroups(): RegisteredGroup[] {
  const filePath = path.join(DATA_DIR, 'registered_groups.json');
  const raw = loadJson<Record<string, RegisteredGroup> | RegisteredGroup[]>(filePath, []);
  if (Array.isArray(raw)) return raw;
  // File is an object keyed by JID — convert to array
  return Object.entries(raw).map(([jid, group]) => ({ ...group, jid }));
}

// ─── Health checks ──────────────────────────────────────────────────────────

export interface HealthCheck {
  name: string;
  status: 'ok' | 'fail' | 'warn';
  detail: string;
}

export function runHealthChecks(): HealthCheck[] {
  const checks: HealthCheck[] = [];

  // 1. Process running
  try {
    execSync('pgrep -f "nanoclaw/dist/index.js"', { stdio: 'ignore' });
    checks.push({ name: 'Process', status: 'ok', detail: 'Running' });
  } catch {
    checks.push({
      name: 'Process',
      status: 'fail',
      detail: 'Not running',
    });
  }

  // 2. Database accessible
  if (!fs.existsSync(DB_PATH)) {
    checks.push({ name: 'Database', status: 'fail', detail: 'File not found' });
    return checks;
  }

  let db: Database.Database;
  try {
    db = openDb();
  } catch (err) {
    checks.push({
      name: 'Database',
      status: 'fail',
      detail: `Cannot open: ${err}`,
    });
    return checks;
  }

  try {
    const count = db
      .prepare('SELECT count(*) as c FROM handlers')
      .get() as { c: number };
    checks.push({
      name: 'Database',
      status: 'ok',
      detail: `Accessible (${count.c} handlers)`,
    });

    // 3. Stale handlers
    const handlers = db
      .prepare(
        "SELECT id, cron, last_triggered FROM handlers WHERE status = 'active' AND cron IS NOT NULL AND last_triggered IS NOT NULL",
      )
      .all() as Array<{ id: string; cron: string; last_triggered: string }>;

    let staleCount = 0;
    const staleNames: string[] = [];
    const now = Date.now();
    for (const h of handlers) {
      const intervalMs = cronToMs(h.cron);
      const lastMs = new Date(h.last_triggered).getTime();
      if (now - lastMs > intervalMs * 3) {
        staleCount++;
        staleNames.push(h.id);
      }
    }

    if (staleCount > 0) {
      checks.push({
        name: 'Stale Handlers',
        status: 'warn',
        detail: `${staleCount} stale: ${staleNames.join(', ')}`,
      });
    } else {
      checks.push({
        name: 'Stale Handlers',
        status: 'ok',
        detail: `All ${handlers.length} cron handlers on schedule`,
      });
    }

    // 4. Event queue
    const unprocessed = db
      .prepare('SELECT count(*) as c FROM events WHERE processed = 0')
      .get() as { c: number };
    if (unprocessed.c > 50) {
      checks.push({
        name: 'Event Queue',
        status: 'warn',
        detail: `${unprocessed.c} unprocessed events`,
      });
    } else {
      checks.push({
        name: 'Event Queue',
        status: 'ok',
        detail: `${unprocessed.c} unprocessed`,
      });
    }

    // 5. WhatsApp activity
    const lastMsg = db
      .prepare('SELECT max(timestamp) as ts FROM messages')
      .get() as { ts: string | null };

    if (lastMsg.ts) {
      const hoursAgo = (now - new Date(lastMsg.ts).getTime()) / 3600000;
      if (hoursAgo > 6) {
        checks.push({
          name: 'WhatsApp',
          status: 'warn',
          detail: `No messages in ${hoursAgo.toFixed(1)}h`,
        });
      } else {
        checks.push({
          name: 'WhatsApp',
          status: 'ok',
          detail: `Last message ${hoursAgo.toFixed(1)}h ago`,
        });
      }
    } else {
      checks.push({
        name: 'WhatsApp',
        status: 'ok',
        detail: 'No messages in DB',
      });
    }
  } finally {
    db.close();
  }

  return checks;
}

function cronToMs(cron: string): number {
  const parts = cron.split(/\s+/);
  const m = parts[0] || '*';
  const h = parts[1] || '*';
  if (m.startsWith('*/')) return parseInt(m.slice(2), 10) * 60000;
  if (h.startsWith('*/')) return parseInt(h.slice(2), 10) * 3600000;
  if (m === '0' && h === '*') return 3600000;
  return 86400000;
}

// ─── Skills ─────────────────────────────────────────────────────────────────

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  installed: boolean;
  source: string;
}

const SKILLS_DIR = path.join(GROUPS_DIR, '.claude', 'skills');
const SKILL_SOURCES_PATH = path.join(DATA_DIR, 'skill_sources.json');

function parseSkillDescription(content: string): string {
  const lines = content.split('\n');
  for (const line of lines) {
    const match = line.match(/^description:\s*(.+)/i);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  }
  // Fallback: first non-empty, non-heading line
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---')) {
      return trimmed.slice(0, 80);
    }
  }
  return '';
}

export function getInstalledSkills(): SkillInfo[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const skills: SkillInfo[] = [];
  try {
    for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const content = fs.readFileSync(skillMd, 'utf-8');
      skills.push({
        name: entry.name,
        description: parseSkillDescription(content),
        path: skillMd,
        installed: true,
        source: '',
      });
    }
  } catch {
    // ignore read errors
  }
  return skills;
}

export function getSkillSources(): string[] {
  return loadJson<string[]>(SKILL_SOURCES_PATH, []);
}

export function addSkillSource(dir: string): void {
  const resolved = dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(2)) : dir;
  const sources = getSkillSources();
  if (!sources.includes(resolved)) {
    sources.push(resolved);
    fs.mkdirSync(path.dirname(SKILL_SOURCES_PATH), { recursive: true });
    fs.writeFileSync(SKILL_SOURCES_PATH, JSON.stringify(sources, null, 2));
  }
}

export function getAvailableSkills(): SkillInfo[] {
  const sources = getSkillSources();
  const installed = new Set(getInstalledSkills().map((s) => s.name));
  const skills: SkillInfo[] = [];

  for (const sourceDir of sources) {
    if (!fs.existsSync(sourceDir)) continue;
    const sourceLabel =
      path.basename(path.dirname(sourceDir)) + '/' + path.basename(sourceDir);
    try {
      const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
      const sorted = entries
        .filter((e) => e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of sorted) {
        const skillMd = path.join(sourceDir, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillMd)) continue;
        if (installed.has(entry.name)) continue;
        const content = fs.readFileSync(skillMd, 'utf-8');
        skills.push({
          name: entry.name,
          description: parseSkillDescription(content),
          path: skillMd,
          installed: false,
          source: sourceLabel,
        });
      }
    } catch {
      // ignore
    }
  }
  return skills;
}

export function installSkill(sourcePath: string, name: string): void {
  const sourceDir = path.dirname(sourcePath);
  const destDir = path.join(SKILLS_DIR, name);
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(sourceDir, destDir, { recursive: true });
}

export function uninstallSkill(name: string): void {
  const dir = path.join(SKILLS_DIR, name);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
  }
}

export function readSkillContent(skillPath: string): string {
  try {
    return fs.readFileSync(skillPath, 'utf-8');
  } catch {
    return '(unable to read file)';
  }
}

// ─── Odyssey ────────────────────────────────────────────────────────────────

export function getOdysseyLogTail(
  groupFolder: string,
  lines = 20,
): string {
  const logPath = path.join(GROUPS_DIR, groupFolder, 'odyssey-log.md');
  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const allLines = content.split('\n');
    return allLines.slice(-lines).join('\n');
  } catch {
    return '(no odyssey log found)';
  }
}
