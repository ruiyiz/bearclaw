import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONFIG_DIR,
  DATA_DIR,
  SKILLS_DIR as BEARCLAW_SKILLS_DIR,
} from '../config.js';
import { resolveRegistry } from '../agent-registry.js';
import {
  agentExists,
  createAgent,
  deleteAgent,
  listAgents,
  loadRegistry,
} from '../store/agents.js';
import { loadJson } from '../utils/json.js';
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
// knows how to route: tg:<id>, imsg:<id>, web:<folder>, <id>@g.us,
// <id>@s.whatsapp.net. Returns the trimmed jid or null when malformed.
export function normalizeChannelJid(raw: string): string | null {
  const jid = raw.trim();
  if (!jid) return null;
  if (/^tg:-?\d+$/.test(jid)) return jid;
  if (/^imsg:.+$/.test(jid)) return jid;
  if (/^web:[A-Za-z0-9._-]+$/.test(jid)) return jid;
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

export function runHealthChecks(): HealthCheck[] {
  const checks: HealthCheck[] = [];

  // 1. Process running — this code executes inside the main process, so the
  // host is by definition up. Report PID + uptime instead of pgrep'ing.
  const uptimeS = Math.round(process.uptime());
  checks.push({
    name: 'Process',
    status: 'ok',
    detail: `pid ${process.pid}, up ${formatUptime(uptimeS)}`,
  });

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

const SKILLS_DIR = BEARCLAW_SKILLS_DIR;
const SKILL_SOURCES_PATH = path.join(CONFIG_DIR, 'skill_sources.json');
const SKILL_INSTALL_META_PATH = path.join(
  CONFIG_DIR,
  'skill_install_meta.json',
);
const CLAUDE_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

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
    const entries = [...fs.readdirSync(SKILLS_DIR, { withFileTypes: true })]
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
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

type SkillInstallMeta = Record<string, { sourcePath: string }>;

function getSkillInstallMeta(): SkillInstallMeta {
  return loadJson<SkillInstallMeta>(SKILL_INSTALL_META_PATH, {});
}

function setSkillInstallMeta(meta: SkillInstallMeta): void {
  fs.mkdirSync(path.dirname(SKILL_INSTALL_META_PATH), { recursive: true });
  fs.writeFileSync(SKILL_INSTALL_META_PATH, JSON.stringify(meta, null, 2));
}

function getSkillSources(): string[] {
  return loadJson<string[]>(SKILL_SOURCES_PATH, []);
}

export function getAllSkillSources(): SkillSource[] {
  const userDirs = getSkillSources();
  const userSources = userDirs.map((dir) => ({
    dir,
    label: path.basename(path.dirname(dir)) + '/' + path.basename(dir),
    builtin: false,
  }));
  const builtins: SkillSource[] = userDirs.includes(CLAUDE_SKILLS_DIR)
    ? []
    : [{ dir: CLAUDE_SKILLS_DIR, label: 'Claude Code', builtin: true }];
  return [...userSources, ...builtins];
}

export function getAvailableSkillsForSource(sourceDir: string): SkillInfo[] {
  if (!fs.existsSync(sourceDir)) return [];
  const installed = new Set(getInstalledSkills().map((s) => s.name));
  const sourceLabel =
    sourceDir === CLAUDE_SKILLS_DIR
      ? 'Claude Code'
      : path.basename(path.dirname(sourceDir)) + '/' + path.basename(sourceDir);
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
  return skills;
}

export function syncInstalledSkills(): { synced: string[]; skipped: string[] } {
  const meta = getSkillInstallMeta();
  const installed = getInstalledSkills();
  const allSources = getAllSkillSources();
  const synced: string[] = [];
  const skipped: string[] = [];

  for (const skill of installed) {
    const knownSource = meta[skill.name]?.sourcePath;
    let sourcePath = knownSource;

    if (!sourcePath || !fs.existsSync(sourcePath)) {
      // Fallback: search all sources
      for (const src of allSources) {
        const candidate = path.join(src.dir, skill.name, 'SKILL.md');
        if (fs.existsSync(candidate)) {
          sourcePath = candidate;
          break;
        }
      }
    }

    if (!sourcePath || !fs.existsSync(sourcePath)) {
      skipped.push(skill.name);
      continue;
    }

    const sourceDir = path.dirname(sourcePath);
    const destDir = path.join(SKILLS_DIR, skill.name);
    try {
      fs.rmSync(destDir, { recursive: true, force: true });
      fs.mkdirSync(destDir, { recursive: true });
      fs.cpSync(sourceDir, destDir, { recursive: true });
      synced.push(skill.name);
      // Update metadata with confirmed source
      meta[skill.name] = { sourcePath };
    } catch {
      skipped.push(skill.name);
    }
  }

  setSkillInstallMeta(meta);
  return { synced, skipped };
}

export function addSkillSource(dir: string): void {
  const resolved = dir.startsWith('~/')
    ? path.join(os.homedir(), dir.slice(2))
    : dir;
  const sources = getSkillSources();
  if (!sources.includes(resolved)) {
    sources.push(resolved);
    fs.mkdirSync(path.dirname(SKILL_SOURCES_PATH), { recursive: true });
    fs.writeFileSync(SKILL_SOURCES_PATH, JSON.stringify(sources, null, 2));
  }
}

export function installSkill(sourcePath: string, name: string): void {
  const sourceDir = path.dirname(sourcePath);
  const destDir = path.join(SKILLS_DIR, name);
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(sourceDir, destDir, { recursive: true });
  const meta = getSkillInstallMeta();
  meta[name] = { sourcePath };
  setSkillInstallMeta(meta);
}

export function uninstallSkill(name: string): void {
  const dir = path.join(SKILLS_DIR, name);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
  }
  const meta = getSkillInstallMeta();
  delete meta[name];
  setSkillInstallMeta(meta);
}

export function readSkillContent(skillPath: string): string {
  try {
    return fs.readFileSync(skillPath, 'utf-8');
  } catch {
    return '(unable to read file)';
  }
}

// ─── Heartbeat ──────────────────────────────────────────────────────────────
