import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { resolveRegistry } from '../agent-registry.js';
import {
  agentExists,
  createAgent,
  deleteAgent,
  listAgents,
  loadRegistry,
} from '../store/agents.js';
import {
  addSkillSource as addSourceDir,
  getSkillFile,
  importSkillDir,
  listSkillSources,
  listSkills,
  parseSkillDescription,
  removeSkill,
  skillMirrorPath,
} from '../store/skills.js';
import { CONFIG_DB_PATH, skillsCacheDir } from '../store/paths.js';
import type { EventRecord, RegisteredAgent } from '../types.js';

const DB_PATH = path.join(DATA_DIR, 'messages.db');

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
      .prepare(
        'SELECT * FROM events WHERE type LIKE ? ORDER BY id DESC LIMIT ?',
      )
      .all(`%${type}%`, limit) as EventRecord[];
  } finally {
    db.close();
  }
}

// ─── Agents ─────────────────────────────────────────────────────────────────

// Resolve the nested registry to the flat jid-keyed view. (The running process
// keeps this view in memory; admin/data reads the database directly for
// out-of-band tools and health checks.)
function loadRegisteredAgents(): Record<string, RegisteredAgent> {
  return resolveRegistry(loadRegistry());
}

export function getRegisteredAgents(): RegisteredAgent[] {
  const raw = loadRegisteredAgents();
  return Object.entries(raw).map(([jid, agent]) => ({ ...agent, jid }));
}

// ─── Channels available for wiring ──────────────────────────────────────────

export type ChannelKind =
  | 'web'
  | 'whatsapp-dm'
  | 'whatsapp-group'
  | 'telegram'
  | 'imessage';

export interface AvailableChannel {
  jid: string;
  name: string;
  kind: ChannelKind;
  lastActivity: string | null;
}

function classifyJid(jid: string): ChannelKind | null {
  if (jid.startsWith('web:')) return 'web';
  if (jid.startsWith('tg:')) return 'telegram';
  if (jid.startsWith('imsg:')) return 'imessage';
  if (jid.endsWith('@g.us')) return 'whatsapp-group';
  if (jid.endsWith('@s.whatsapp.net')) return 'whatsapp-dm';
  return null;
}

// Validates a manually-entered channel jid. Accepts the shapes the router
// knows how to route: tg:<id>, imsg:<id>, web:<folder>, email:<folder>,
// <id>@g.us, <id>@s.whatsapp.net. Returns the trimmed jid or null when
// malformed.
export function normalizeChannelJid(raw: string): string | null {
  const jid = raw.trim();
  if (!jid) return null;
  if (/^tg:-?\d+$/.test(jid)) return jid;
  if (/^imsg:.+$/.test(jid)) return jid;
  if (/^web:[A-Za-z0-9._-]+$/.test(jid)) return jid;
  if (/^email:[A-Za-z0-9._-]+$/.test(jid)) return jid;
  if (/^\d+@g\.us$/.test(jid)) return jid;
  if (/^\d+@s\.whatsapp\.net$/.test(jid)) return jid;
  return null;
}

export function getAvailableChannels(): AvailableChannel[] {
  const registered = new Set(Object.keys(loadRegisteredAgents()));
  const db = openDb();
  try {
    const rows = db
      .prepare(
        `SELECT jid, name, last_message_time FROM chats
         WHERE jid != '__group_sync__'
         ORDER BY last_message_time DESC`,
      )
      .all() as Array<{
      jid: string;
      name: string;
      last_message_time: string;
    }>;
    const out: AvailableChannel[] = [];
    for (const r of rows) {
      if (registered.has(r.jid)) continue;
      const kind = classifyJid(r.jid);
      if (!kind) continue;
      // Web threads (web:<folder>:<sessionId>) each get a chats row, but web
      // wiring is per-folder via the dedicated "Web" option — never per
      // session. Keep them out of the chat picker.
      if (kind === 'web') continue;
      out.push({
        jid: r.jid,
        name: r.name || r.jid,
        kind,
        lastActivity: r.last_message_time,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

// ─── Agent folder management ────────────────────────────────────────────────
// Thin wrappers over store/agents: the `agents` table is the registry, and an
// agent's markdown lives in context_files, so there is no folder to create.

export interface CreateAgentFolderOpts {
  folder: string;
  displayName: string;
  templateFolder?: string;
}

export function agentFolderExists(folder: string): boolean {
  return agentExists(folder);
}

export function listAgentFolders(): string[] {
  return listAgents();
}

export function createAgentFolder(opts: CreateAgentFolderOpts): void {
  createAgent(opts.folder, opts.displayName, {
    template: opts.templateFolder,
  });
}

export function deleteAgentFolderDir(
  folder: string,
  opts: { includeVar?: boolean } = {},
): void {
  deleteAgent(folder, opts);
}

// Shape of an in-place patch for a registered agent entry. The runtime owns
// persistence — see HttpServerOpts.updateRegisteredAgent in src/server/http.ts.
export interface AgentEntryPatch {
  name?: string;
  trigger?: string;
  primary?: boolean;
}

// ─── Health checks ──────────────────────────────────────────────────────────

export interface HealthCheck {
  name: string;
  status: 'ok' | 'fail' | 'warn';
  detail: string;
}

// Process check plus everything runDbHealthChecks covers. The doctor command
// runs out of process, where the PID check means nothing, so it calls
// runDbHealthChecks directly.
export function runHealthChecks(): HealthCheck[] {
  // This code executes inside the main process, so the host is by definition
  // up. Report PID + uptime instead of pgrep'ing.
  const uptimeS = Math.round(process.uptime());
  return [
    {
      name: 'Process',
      status: 'ok',
      detail: `pid ${process.pid}, up ${formatUptime(uptimeS)}`,
    },
    ...runDbHealthChecks(),
  ];
}

export function runDbHealthChecks(): HealthCheck[] {
  const checks: HealthCheck[] = [];

  // 1. Database files present
  const missing = [DB_PATH, CONFIG_DB_PATH].filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    checks.push({
      name: 'Database',
      status: 'fail',
      detail: `Not found: ${missing.map((f) => path.basename(f)).join(', ')}`,
    });
    if (!fs.existsSync(DB_PATH)) return checks;
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
    const count = db.prepare('SELECT count(*) as c FROM workflows').get() as {
      c: number;
    };
    checks.push({
      name: 'Database',
      status: 'ok',
      detail: `Accessible (${count.c} workflows)`,
    });

    // 3. Overdue triggers: a cron row whose slot passed by more than three
    // intervals means the service loop is not firing.
    const overdue = db
      .prepare(
        `SELECT id, next_run_at, config FROM workflow_triggers
         WHERE enabled = 1 AND type = 'cron' AND next_run_at IS NOT NULL AND next_run_at < ?`,
      )
      .all(new Date().toISOString()) as Array<{
      id: string;
      next_run_at: string;
      config: string;
    }>;

    const stale: string[] = [];
    const now = Date.now();
    for (const t of overdue) {
      let cron = '';
      try {
        cron = (JSON.parse(t.config) as { cron?: string }).cron ?? '';
      } catch {
        cron = '';
      }
      const intervalMs = cronToMs(cron);
      if (now - new Date(t.next_run_at).getTime() > intervalMs * 3)
        stale.push(t.id);
    }

    if (stale.length > 0) {
      checks.push({
        name: 'Overdue Triggers',
        status: 'warn',
        detail: `${stale.length} overdue: ${stale.join(', ')}`,
      });
    } else {
      checks.push({
        name: 'Overdue Triggers',
        status: 'ok',
        detail: 'Every cron trigger is on schedule',
      });
    }

    // 3b. Runs left waiting on a person.
    const waiting = db
      .prepare("SELECT count(*) as c FROM workflow_waits WHERE status = 'open'")
      .get() as { c: number };
    checks.push({
      name: 'Open Waits',
      status: waiting.c > 20 ? 'warn' : 'ok',
      detail: `${waiting.c} waiting on a human`,
    });

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

  // 6. Email poll health — one check per folder with an email channel, read
  // from the status files the EmailChannel writes after each poll.
  for (const folder of Object.keys(loadRegisteredAgents()).reduce<Set<string>>(
    (set, jid) => {
      if (jid.startsWith('email:')) set.add(jid.slice('email:'.length));
      return set;
    },
    new Set(),
  )) {
    const statusPath = path.join(DATA_DIR, `email_status_${folder}.json`);
    if (!fs.existsSync(statusPath)) {
      checks.push({
        name: `Email (${folder})`,
        status: 'warn',
        detail: 'No poll has run yet',
      });
      continue;
    }
    try {
      const s = JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as {
        lastPollOk?: boolean;
        lastPollAt?: string;
        lastPollError?: string | null;
      };
      checks.push({
        name: `Email (${folder})`,
        status: s.lastPollOk ? 'ok' : 'fail',
        detail: s.lastPollOk
          ? `Last poll ok${s.lastPollAt ? ` at ${s.lastPollAt}` : ''}`
          : `Last poll failed: ${s.lastPollError || 'unknown'}`,
      });
    } catch (err) {
      checks.push({
        name: `Email (${folder})`,
        status: 'warn',
        detail: `Cannot read status: ${err}`,
      });
    }
  }

  return checks;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
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

// Thin wrappers over store/skills. Installed skills live in the config
// database; `path` names their mirrored copy under var/cache/skills, which is
// what the SDK actually opens.

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  installed: boolean;
  source: string;
}

export interface SkillSource {
  dir: string;
  label: string;
  builtin: boolean;
}

const CLAUDE_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

function sourceLabel(dir: string): string {
  if (dir === CLAUDE_SKILLS_DIR) return 'Claude Code';
  return path.basename(path.dirname(dir)) + '/' + path.basename(dir);
}

export function getInstalledSkills(): SkillInfo[] {
  return listSkills().map((s) => ({
    name: s.name,
    description: s.description,
    path: skillMirrorPath(s.name),
    installed: true,
    source: '',
  }));
}

export function getAllSkillSources(): SkillSource[] {
  const userDirs = listSkillSources();
  const userSources = userDirs.map((dir) => ({
    dir,
    label: sourceLabel(dir),
    builtin: false,
  }));
  const builtins: SkillSource[] = userDirs.includes(CLAUDE_SKILLS_DIR)
    ? []
    : [{ dir: CLAUDE_SKILLS_DIR, label: 'Claude Code', builtin: true }];
  return [...userSources, ...builtins];
}

// Uninstalled skills are still read straight off disk: they have no rows yet.
export function getAvailableSkillsForSource(sourceDir: string): SkillInfo[] {
  if (!sourceDir || !fs.existsSync(sourceDir)) return [];
  const installed = new Set(listSkills().map((s) => s.name));
  const label = sourceLabel(sourceDir);
  const skills: SkillInfo[] = [];
  try {
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    const sorted = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      const skillMd = path.join(sourceDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      if (installed.has(entry.name)) continue;
      skills.push({
        name: entry.name,
        description: parseSkillDescription(fs.readFileSync(skillMd, 'utf-8')),
        path: skillMd,
        installed: false,
        source: label,
      });
    }
  } catch {
    // ignore
  }
  return skills;
}

// Re-import every installed skill from the directory it came from, falling
// back to a matching directory under any registered source.
export function syncInstalledSkills(): { synced: string[]; skipped: string[] } {
  const sources = getAllSkillSources();
  const synced: string[] = [];
  const skipped: string[] = [];

  for (const skill of listSkills()) {
    let sourcePath = skill.sourcePath ?? undefined;
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      sourcePath = undefined;
      for (const src of sources) {
        const candidate = path.join(src.dir, skill.name, 'SKILL.md');
        if (fs.existsSync(candidate)) {
          sourcePath = candidate;
          break;
        }
      }
    }
    if (!sourcePath) {
      skipped.push(skill.name);
      continue;
    }
    try {
      importSkillDir(path.dirname(sourcePath), skill.name, sourcePath);
      synced.push(skill.name);
    } catch {
      skipped.push(skill.name);
    }
  }

  return { synced, skipped };
}

export function addSkillSource(dir: string): void {
  const resolved = dir.startsWith('~/')
    ? path.join(os.homedir(), dir.slice(2))
    : dir;
  addSourceDir(resolved);
}

export function installSkill(sourcePath: string, name: string): void {
  importSkillDir(path.dirname(sourcePath), name, sourcePath);
}

export function uninstallSkill(name: string): void {
  removeSkill(name);
}

// Installed skills answer from the database; anything else is a source file
// still sitting on disk.
export function readSkillContent(skillPath: string): string {
  const mirror = skillsCacheDir();
  const rel = path.relative(mirror, skillPath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    const parts = rel.split(path.sep);
    const file = getSkillFile(parts[0], parts.slice(1).join('/'));
    if (file) return file.content.toString('utf-8');
    return '(unable to read file)';
  }
  try {
    return fs.readFileSync(skillPath, 'utf-8');
  } catch {
    return '(unable to read file)';
  }
}

// ─── Heartbeat ──────────────────────────────────────────────────────────────
