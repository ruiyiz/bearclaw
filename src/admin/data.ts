import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  AGENTS_DIR,
  AGENTS_VAR_DIR,
  CONFIG_DIR,
  CONTEXT_DIR,
  DATA_DIR,
  MAIN_AGENT_FOLDER,
  SKILLS_DIR as NANOCLAW_SKILLS_DIR,
  agentDir,
  agentVarDir,
} from '../config.js';
import { loadJson } from '../utils/json.js';
import type {
  EventRecord,
  Handler,
  HandlerRunLog,
  RegisteredAgent,
} from '../types.js';

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

// ─── Agents ─────────────────────────────────────────────────────────────────

const REGISTERED_AGENTS_PATH = path.join(CONFIG_DIR, 'registered_agents.json');
const AGENT_FOLDER_RE = /^[A-Za-z0-9._-]+$/;

function loadRegisteredAgents(): Record<string, RegisteredAgent> {
  const raw = loadJson<Record<string, RegisteredAgent> | RegisteredAgent[]>(
    REGISTERED_AGENTS_PATH,
    {},
  );
  if (Array.isArray(raw)) {
    const out: Record<string, RegisteredAgent> = {};
    for (const a of raw) {
      const { jid: _jid, ...rest } = a as RegisteredAgent & { jid?: string };
      if (_jid) out[_jid] = rest as RegisteredAgent;
    }
    return out;
  }
  return raw;
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

function validateFolder(folder: string): void {
  if (!folder || !AGENT_FOLDER_RE.test(folder)) {
    throw new Error(
      'invalid folder (allowed: letters, digits, dot, dash, underscore)',
    );
  }
}

const DEFAULT_IDENTITY = (name: string): string =>
  `# ${name}\n\nDescribe this agent's identity, role, and behaviour here.\n`;

export interface CreateAgentFolderOpts {
  folder: string;
  displayName: string;
  templateFolder?: string;
}

export function agentFolderExists(folder: string): boolean {
  try {
    return fs.statSync(agentDir(folder)).isDirectory();
  } catch {
    return false;
  }
}

export function listAgentFolders(): string[] {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs
    .readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

export function createAgentFolder(opts: CreateAgentFolderOpts): void {
  validateFolder(opts.folder);
  if (opts.templateFolder) validateFolder(opts.templateFolder);
  const dest = agentDir(opts.folder);
  if (fs.existsSync(dest)) {
    throw new Error(`agent folder already exists: ${opts.folder}`);
  }
  fs.mkdirSync(dest, { recursive: true });
  if (opts.templateFolder) {
    const src = agentDir(opts.templateFolder);
    if (!fs.existsSync(src)) {
      throw new Error(`template folder not found: ${opts.templateFolder}`);
    }
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      fs.copyFileSync(path.join(src, entry.name), path.join(dest, entry.name));
    }
  } else {
    fs.writeFileSync(
      path.join(dest, 'IDENTITY.md'),
      DEFAULT_IDENTITY(opts.displayName),
    );
  }
}

export function deleteAgentFolderDir(
  folder: string,
  opts: { includeVar?: boolean } = {},
): void {
  validateFolder(folder);
  if (folder === MAIN_AGENT_FOLDER) {
    throw new Error('cannot delete main agent folder');
  }
  const dest = agentDir(folder);
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  if (opts.includeVar) {
    const varDest = path.join(AGENTS_VAR_DIR, folder);
    if (fs.existsSync(varDest)) {
      fs.rmSync(varDest, { recursive: true, force: true });
    }
  }
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
    const count = db.prepare('SELECT count(*) as c FROM handlers').get() as {
      c: number;
    };
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

const SKILLS_DIR = NANOCLAW_SKILLS_DIR;
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

// ─── Context files ──────────────────────────────────────────────────────────

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

const NAME_RE = /^[A-Za-z0-9._-]+\.md$/;
const FOLDER_RE = /^[A-Za-z0-9._-]+$/;

function statContextFile(
  scope: ContextScope,
  folder: string | null,
  name: string,
  full: string,
): ContextFile {
  const st = fs.statSync(full);
  return {
    scope,
    folder,
    name,
    path: full,
    size: st.size,
    modifiedAt: st.mtime.toISOString(),
  };
}

function listMarkdownIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

export function listContextFiles(): ContextListing {
  const shared = listMarkdownIn(CONTEXT_DIR).map((n) =>
    statContextFile('shared', null, n, path.join(CONTEXT_DIR, n)),
  );
  const agents: Array<{ folder: string; files: ContextFile[] }> = [];
  if (fs.existsSync(AGENTS_DIR)) {
    const entries = fs
      .readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const agentDir = path.join(AGENTS_DIR, e.name);
      const files = listMarkdownIn(agentDir).map((n) =>
        statContextFile('agent', e.name, n, path.join(agentDir, n)),
      );
      agents.push({ folder: e.name, files });
    }
  }
  return { shared, agents };
}

function resolveContextPath(
  scope: ContextScope,
  folder: string | null,
  name: string,
): string {
  if (!NAME_RE.test(name)) throw new Error('invalid filename');
  if (scope === 'shared') {
    return path.join(CONTEXT_DIR, name);
  }
  if (!folder || !FOLDER_RE.test(folder)) throw new Error('invalid folder');
  const agentDir = path.join(AGENTS_DIR, folder);
  if (!fs.existsSync(agentDir) || !fs.statSync(agentDir).isDirectory()) {
    throw new Error('agent folder not found');
  }
  return path.join(agentDir, name);
}

export function readContextFile(
  scope: ContextScope,
  folder: string | null,
  name: string,
): { content: string; modifiedAt: string } {
  const full = resolveContextPath(scope, folder, name);
  const st = fs.statSync(full);
  const content = fs.readFileSync(full, 'utf-8');
  return { content, modifiedAt: st.mtime.toISOString() };
}

export function writeContextFile(
  scope: ContextScope,
  folder: string | null,
  name: string,
  content: string,
): { modifiedAt: string } {
  const full = resolveContextPath(scope, folder, name);
  const dir = path.dirname(full);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, full);
  const st = fs.statSync(full);
  return { modifiedAt: st.mtime.toISOString() };
}

export function createContextFile(
  scope: ContextScope,
  folder: string | null,
  name: string,
  content = '',
): { modifiedAt: string } {
  const full = resolveContextPath(scope, folder, name);
  if (fs.existsSync(full)) throw new Error('file already exists');
  return writeContextFile(scope, folder, name, content);
}

export function deleteContextFile(
  scope: ContextScope,
  folder: string | null,
  name: string,
): void {
  const full = resolveContextPath(scope, folder, name);
  if (!fs.existsSync(full)) throw new Error('file not found');
  fs.unlinkSync(full);
}

// ─── Heartbeat ──────────────────────────────────────────────────────────────

export function getHeartbeatLogTail(agentFolder: string, lines = 20): string {
  const logPath = path.join(agentVarDir(agentFolder), 'heartbeat-log.md');
  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const allLines = content.split('\n');
    return allLines.slice(-lines).join('\n');
  } catch {
    return '(no heartbeat log found)';
  }
}
