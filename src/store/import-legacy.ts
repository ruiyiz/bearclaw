import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

import { isNestedRegistry, migrateFlatToNested } from '../agent-registry.js';
import type { AgentRegistry, RegisteredAgent } from '../types.js';
import {
  WorkflowValidationError,
  parseDefinition,
} from '../workflows/schema.js';
import { getConfigDb, initConfigDb } from './config-db.js';
import { materializeAll } from './materialize.js';
import { BEARCLAW_HOME } from './paths.js';
import { parseSkillDescription, walkSkillDir } from './skills.js';
import {
  PASSWORD_HASH_KEY,
  getSetting,
  isSecretKey,
  setOnboarded,
  setPassword,
  setSetting,
} from './settings.js';

// Env vars that describe *where* the install lives. Importing them into the
// database would let a copied database point a fresh machine at a stale path.
const ENV_SKIP = new Set(['BEARCLAW_HOME', 'BEARCLAW_WORKFLOWS_DIR']);

export interface ImportOptions {
  home?: string;
  force?: boolean;
  dryRun?: boolean;
  /** Opt out of retiring the imported files to legacy-YYYYMMDD/. */
  keepFiles?: boolean;
}

export interface ImportReport {
  home: string;
  dryRun: boolean;
  force: boolean;
  keepFiles: boolean;
  detected: string[];
  settings: string[];
  skippedSettings: string[];
  passwordSet: boolean;
  agents: string[];
  contextFiles: string[];
  skills: { name: string; files: number }[];
  skillSources: string[];
  mcpServers: string[];
  modelCatalog: boolean;
  workflows: string[];
  movedRuntimeFiles: { from: string; to: string }[];
  legacyDir: string | null;
  onboarded: boolean;
  errors: { source: string; issues: string[] }[];
}

const ROLLBACK = Symbol('dry-run rollback');

function nowIso(): string {
  return new Date().toISOString();
}

function emptyReport(
  home: string,
  opts: Required<Omit<ImportOptions, 'home'>>,
): ImportReport {
  return {
    home,
    dryRun: opts.dryRun,
    force: opts.force,
    keepFiles: opts.keepFiles,
    detected: [],
    settings: [],
    skippedSettings: [],
    passwordSet: false,
    agents: [],
    contextFiles: [],
    skills: [],
    skillSources: [],
    mcpServers: [],
    modelCatalog: false,
    workflows: [],
    movedRuntimeFiles: [],
    legacyDir: null,
    onboarded: false,
    errors: [],
  };
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

function isZeroByte(file: string): boolean {
  try {
    return fs.statSync(file).size === 0;
  } catch {
    return false;
  }
}

export function detectLegacyPaths(home: string = BEARCLAW_HOME): string[] {
  const found: string[] = [];
  const always = [
    '.env',
    'context',
    'agents',
    'skills',
    'workflows',
    'config',
    '.claude',
    '.git',
    '.gitignore',
    'workflows-retired',
  ];
  for (const rel of always) {
    if (fs.existsSync(path.join(home, rel))) found.push(rel);
  }
  // Orphans: only interesting because they are empty leftovers.
  if (isZeroByte(path.join(home, 'messages.db'))) found.push('messages.db');
  if (isZeroByte(path.join(home, 'var', 'bearclaw.db')))
    found.push('var/bearclaw.db');
  if (fs.existsSync(path.join(home, 'var', 'initial-password')))
    found.push('var/initial-password');
  return found;
}

function legacyDirName(home: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const base = path.join(home, `legacy-${day}`);
  if (!fs.existsSync(base)) return base;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return path.join(home, `legacy-${day}-${time}`);
}

export function importLegacyFs(opts: ImportOptions = {}): ImportReport {
  const home = opts.home ? path.resolve(opts.home) : BEARCLAW_HOME;
  const resolved = {
    force: opts.force ?? false,
    dryRun: opts.dryRun ?? false,
    keepFiles: opts.keepFiles ?? false,
  };
  const report = emptyReport(home, resolved);
  report.detected = detectLegacyPaths(home);

  initConfigDb(path.join(home, 'bearclaw.db'));
  const db = getConfigDb();

  const runImport = db.transaction(() => {
    importSettings(home, report, resolved.force);
    importAgents(home, report, resolved.force);
    importContext(home, report, resolved.force);
    importSkills(home, report, resolved.force);
    importMcpAndModels(home, report, resolved.force);
    importWorkflows(home, report, resolved.force);
    importInitialPassword(home, report);
    if (readyToOnboard()) {
      setOnboarded();
      report.onboarded = true;
    }
    setSetting('bearclaw.imported_at', nowIso(), { secret: false });
    if (resolved.dryRun) throw ROLLBACK;
  });

  try {
    runImport();
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }

  if (!resolved.dryRun) materializeAll(home);

  planRuntimeFileMoves(home, report);
  if (!resolved.dryRun && !resolved.keepFiles) {
    performRuntimeFileMoves(report);
    report.legacyDir = retireLegacyPaths(home, report.detected);
    if (report.legacyDir) {
      setSetting('bearclaw.legacy_dir', report.legacyDir, { secret: false });
    }
  }
  return report;
}

// ─── Steps ──────────────────────────────────────────────────────────────────

function importSettings(
  home: string,
  report: ImportReport,
  force: boolean,
): void {
  const envPath = path.join(home, '.env');
  if (!fs.existsSync(envPath)) return;
  let parsed: Record<string, string>;
  try {
    parsed = dotenv.parse(fs.readFileSync(envPath));
  } catch (err) {
    report.errors.push({ source: '.env', issues: [String(err)] });
    return;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (ENV_SKIP.has(key)) {
      report.skippedSettings.push(key);
      continue;
    }
    if (key === 'BEARCLAW_PASSWORD') {
      if (value && (force || !getSetting(PASSWORD_HASH_KEY))) {
        setPassword(value);
        report.passwordSet = true;
      }
      continue;
    }
    if (insertSetting(key, value, force)) report.settings.push(key);
  }
}

function insertSetting(key: string, value: string, force: boolean): boolean {
  if (force) {
    setSetting(key, value, { secret: isSecretKey(key) });
    return true;
  }
  const info = getConfigDb()
    .prepare(
      'INSERT OR IGNORE INTO settings (key, value, secret, updated_at) VALUES (?, ?, ?, ?)',
    )
    .run(key, value, isSecretKey(key) ? 1 : 0, nowIso());
  return info.changes > 0;
}

function importAgents(
  home: string,
  report: ImportReport,
  force: boolean,
): void {
  const file = path.join(home, 'config', 'registered_agents.json');
  if (!fs.existsSync(file)) return;
  const raw = readJson<unknown>(file);
  if (!raw || typeof raw !== 'object') {
    report.errors.push({
      source: 'config/registered_agents.json',
      issues: ['not a JSON object'],
    });
    return;
  }
  let registry: AgentRegistry;
  try {
    registry = isNestedRegistry(raw)
      ? (raw as AgentRegistry)
      : migrateFlatToNested(raw as Record<string, RegisteredAgent>);
  } catch (err) {
    report.errors.push({
      source: 'config/registered_agents.json',
      issues: [err instanceof Error ? err.message : String(err)],
    });
    return;
  }
  const verb = force ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
  const stmt = getConfigDb().prepare(
    `${verb} INTO agents (folder, name, channels, container_config, heartbeat, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const ts = nowIso();
  for (const [folder, agent] of Object.entries(registry)) {
    const info = stmt.run(
      folder,
      agent.name ?? folder,
      JSON.stringify(agent.channels ?? {}),
      agent.containerConfig ? JSON.stringify(agent.containerConfig) : null,
      agent.heartbeat ? JSON.stringify(agent.heartbeat) : null,
      ts,
      ts,
    );
    if (info.changes > 0) report.agents.push(folder);
  }
}

function importContext(
  home: string,
  report: ImportReport,
  force: boolean,
): void {
  const verb = force ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
  const stmt = getConfigDb().prepare(
    `${verb} INTO context_files (scope, folder, name, content, updated_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const ts = nowIso();

  const contextDir = path.join(home, 'context');
  if (fs.existsSync(contextDir)) {
    for (const entry of fs
      .readdirSync(contextDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const content = fs.readFileSync(
        path.join(contextDir, entry.name),
        'utf-8',
      );
      const info = stmt.run('shared', '', entry.name, content, ts);
      if (info.changes > 0) report.contextFiles.push(`shared:${entry.name}`);
    }
  }

  const agentsDir = path.join(home, 'agents');
  if (!fs.existsSync(agentsDir)) return;
  for (const folderEntry of fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!folderEntry.isDirectory() || folderEntry.name.startsWith('.'))
      continue;
    const folder = folderEntry.name;
    for (const entry of fs
      .readdirSync(path.join(agentsDir, folder), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const content = fs.readFileSync(
        path.join(agentsDir, folder, entry.name),
        'utf-8',
      );
      const info = stmt.run('agent', folder, entry.name, content, ts);
      if (info.changes > 0)
        report.contextFiles.push(`agent:${folder}/${entry.name}`);
    }
  }
}

function importSkills(
  home: string,
  report: ImportReport,
  force: boolean,
): void {
  const db = getConfigDb();
  const ts = nowIso();
  const meta =
    readJson<Record<string, { sourcePath?: string }>>(
      path.join(home, 'config', 'skill_install_meta.json'),
    ) ?? {};

  const skillsDir = path.join(home, 'skills');
  if (fs.existsSync(skillsDir)) {
    const skillStmt = db.prepare(
      `${force ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE'} INTO skills
       (name, description, source_path, installed_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    );
    const fileStmt = db.prepare(
      `${force ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE'} INTO skill_files
       (skill, relpath, content, mode, updated_at) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const entry of fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = path.join(skillsDir, entry.name);
      const skillMd = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) {
        report.errors.push({
          source: `skills/${entry.name}`,
          issues: ['no SKILL.md — skipped'],
        });
        continue;
      }
      const description = parseSkillDescription(
        fs.readFileSync(skillMd, 'utf-8'),
      );
      const inserted = skillStmt.run(
        entry.name,
        description,
        meta[entry.name]?.sourcePath ?? null,
        ts,
        ts,
      );
      let files = 0;
      for (const file of walkSkillDir(dir)) {
        const info = fileStmt.run(
          entry.name,
          file.relpath,
          fs.readFileSync(file.abs),
          file.mode,
          ts,
        );
        if (info.changes > 0) files += 1;
      }
      if (inserted.changes > 0 || files > 0)
        report.skills.push({ name: entry.name, files });
    }
  }

  const sources =
    readJson<string[]>(path.join(home, 'config', 'skill_sources.json')) ?? [];
  const sourceStmt = db.prepare(
    'INSERT OR IGNORE INTO skill_sources (dir, added_at) VALUES (?, ?)',
  );
  for (const dir of sources) {
    if (typeof dir !== 'string' || !dir) continue;
    if (sourceStmt.run(dir, ts).changes > 0) report.skillSources.push(dir);
  }
}

function importMcpAndModels(
  home: string,
  report: ImportReport,
  force: boolean,
): void {
  const db = getConfigDb();
  const ts = nowIso();

  const mcp = readJson<{ mcpServers?: Record<string, unknown> }>(
    path.join(home, 'config', 'mcp.json'),
  );
  if (mcp?.mcpServers && typeof mcp.mcpServers === 'object') {
    const stmt = db.prepare(
      `${force ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE'} INTO mcp_servers
       (name, config, enabled, updated_at) VALUES (?, ?, 1, ?)`,
    );
    for (const [name, config] of Object.entries(mcp.mcpServers)) {
      if (stmt.run(name, JSON.stringify(config), ts).changes > 0)
        report.mcpServers.push(name);
    }
  }

  const catalog = readJson<{ models?: unknown[] }>(
    path.join(home, 'config', 'model-catalog.json'),
  );
  if (Array.isArray(catalog?.models) && catalog.models.length > 0) {
    const stmt = db.prepare(
      `${force ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE'} INTO model_catalog
       (id, catalog, updated_at) VALUES (1, ?, ?)`,
    );
    if (stmt.run(JSON.stringify(catalog), ts).changes > 0)
      report.modelCatalog = true;
  }
}

function importWorkflows(
  home: string,
  report: ImportReport,
  force: boolean,
): void {
  const dir = path.join(home, 'workflows');
  if (!fs.existsSync(dir)) return;
  const stmt = getConfigDb().prepare(
    `${force ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE'} INTO workflow_definitions
     (slug, definition, updated_at) VALUES (?, ?, ?)`,
  );
  const ts = nowIso();
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    try {
      const def = parseDefinition(
        JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')),
      );
      if (stmt.run(def.slug, JSON.stringify(def), ts).changes > 0)
        report.workflows.push(def.slug);
    } catch (err) {
      const issues =
        err instanceof WorkflowValidationError
          ? err.issues
          : [err instanceof Error ? err.message : String(err)];
      report.errors.push({ source: `workflows/${file}`, issues });
    }
  }
}

function importInitialPassword(home: string, report: ImportReport): void {
  if (getSetting(PASSWORD_HASH_KEY)) return;
  const file = path.join(home, 'var', 'initial-password');
  if (!fs.existsSync(file)) return;
  const pw = fs.readFileSync(file, 'utf-8').trim();
  if (!pw) return;
  setPassword(pw);
  report.passwordSet = true;
}

function readyToOnboard(): boolean {
  const model = getSetting('DEFAULT_MODEL') || process.env.DEFAULT_MODEL;
  const password =
    getSetting(PASSWORD_HASH_KEY) || process.env.BEARCLAW_PASSWORD;
  const claudeAuth =
    getSetting('CLAUDE_CODE_OAUTH_TOKEN') ||
    getSetting('ANTHROPIC_API_KEY') ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.ANTHROPIC_API_KEY;
  return Boolean(model && password && claudeAuth);
}

// ─── File moves (only when keepFiles is off) ────────────────────────────────

// Runtime state a skill script wrote next to the agent's markdown. It belongs
// under var/, not in the config tree.
function planRuntimeFileMoves(home: string, report: ImportReport): void {
  const agentsDir = path.join(home, 'agents');
  if (!fs.existsSync(agentsDir)) return;
  for (const folderEntry of fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!folderEntry.isDirectory() || folderEntry.name.startsWith('.'))
      continue;
    const folder = folderEntry.name;
    for (const entry of fs
      .readdirSync(path.join(agentsDir, folder), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || entry.name.endsWith('.md')) continue;
      if (entry.name.startsWith('.')) continue;
      report.movedRuntimeFiles.push({
        from: path.join(agentsDir, folder, entry.name),
        to: path.join(home, 'var', 'agents', folder, entry.name),
      });
    }
  }
}

function performRuntimeFileMoves(report: ImportReport): void {
  for (const move of report.movedRuntimeFiles) {
    try {
      fs.mkdirSync(path.dirname(move.to), { recursive: true });
      fs.renameSync(move.from, move.to);
    } catch (err) {
      report.errors.push({
        source: move.from,
        issues: [`could not move to ${move.to}: ${String(err)}`],
      });
    }
  }
}

// Never removes anything: the legacy tree is the operator's only copy of the
// pre-migration state, including the .git history.
function retireLegacyPaths(home: string, detected: string[]): string | null {
  if (detected.length === 0) return null;
  const dest = legacyDirName(home);
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of detected) {
    const from = path.join(home, rel);
    if (!fs.existsSync(from)) continue;
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  }
  return dest;
}
