import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// `bearclaw doctor` answers "why is it not working" without reading any code:
// one line per check, exit 1 when something is actually broken. It runs out of
// process, so every check has to tolerate a stopped install.

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorOptions {
  json?: boolean;
  skipServices?: boolean;
}

const LABELS = ['com.bearclaw', 'com.bearclaw.web'];
const HTTP_PORT = process.env.BEARCLAW_HTTP_PORT || '7878';

function countFiles(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) total += countFiles(path.join(dir, entry.name));
    else total += 1;
  }
  return total;
}

async function probe(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      redirect: 'manual',
    });
    return res.status;
  } catch {
    return null;
  }
}

export async function collectChecks(
  opts: DoctorOptions = {},
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string): void => {
    checks.push({ name, status, detail });
  };

  const major = Number(process.versions.node.split('.')[0]);
  add(
    'node',
    major >= 20 ? 'ok' : 'fail',
    `${process.versions.node}${major >= 20 ? '' : ' (need 20+)'}`,
  );

  const claude = spawnSync('which', ['claude'], { encoding: 'utf-8' });
  add(
    'claude cli',
    claude.status === 0 ? 'ok' : 'warn',
    claude.status === 0 ? claude.stdout.trim() : 'not on PATH',
  );

  const { BEARCLAW_HOME, CONFIG_DB_PATH, VAR_DIR, agentVarDir } =
    await import('../store/paths.js');
  add('home', fs.existsSync(BEARCLAW_HOME) ? 'ok' : 'fail', BEARCLAW_HOME);

  let dbOpen = false;
  if (!fs.existsSync(CONFIG_DB_PATH)) {
    add(
      'bearclaw.db',
      'fail',
      `missing: ${CONFIG_DB_PATH} (run bearclaw setup)`,
    );
  } else {
    const mode = fs.statSync(CONFIG_DB_PATH).mode & 0o777;
    add(
      'bearclaw.db mode',
      mode === 0o600 ? 'ok' : 'warn',
      `0${mode.toString(8)}${mode === 0o600 ? '' : ' (expected 0600)'}`,
    );
    try {
      const { initConfigDb } = await import('../store/config-db.js');
      const { LATEST_VERSION, schemaVersion } =
        await import('../store/migrations.js');
      const db = initConfigDb(CONFIG_DB_PATH);
      const version = schemaVersion(db);
      dbOpen = true;
      add(
        'bearclaw.db schema',
        version === LATEST_VERSION ? 'ok' : 'warn',
        `v${version} of v${LATEST_VERSION}`,
      );
    } catch (err) {
      add(
        'bearclaw.db schema',
        'fail',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (dbOpen) {
    const settings = await import('../store/settings.js');
    settings.loadSettingsIntoEnv();

    const authKey = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'].find(
      (key) => process.env[key] || settings.getSetting(key),
    );
    add(
      'claude auth',
      authKey ? 'ok' : 'fail',
      authKey ?? 'no token or API key configured',
    );

    const model =
      settings.getSetting('DEFAULT_MODEL') || process.env.DEFAULT_MODEL || '';
    if (!model) {
      add('default model', 'fail', 'DEFAULT_MODEL is not set');
    } else {
      const { aliasForId, resolveModelAlias } = await import('../models.js');
      const known =
        Boolean(resolveModelAlias(model)) || aliasForId(model) !== model;
      add('default model', known ? 'ok' : 'warn', model);
    }

    const stored = Boolean(settings.getSetting(settings.PASSWORD_HASH_KEY));
    const fromEnv = Boolean(process.env.BEARCLAW_PASSWORD);
    add(
      'password',
      stored || fromEnv ? 'ok' : 'fail',
      stored
        ? 'hash stored'
        : fromEnv
          ? 'BEARCLAW_PASSWORD from the environment'
          : 'no web password (run bearclaw setup)',
    );

    add(
      'onboarded',
      settings.isOnboarded() ? 'ok' : 'warn',
      settings.isOnboarded() ? 'yes' : 'finish setup at /setup',
    );

    add(
      'telegram',
      settings.getSetting('TELEGRAM_BOT_TOKEN') ? 'ok' : 'warn',
      settings.getSetting('TELEGRAM_BOT_TOKEN')
        ? 'token configured'
        : 'no bot token (channel off)',
    );

    const { getConfigDb } = await import('../store/config-db.js');
    const { skillsCacheDir } = await import('../store/paths.js');
    const rows = (
      getConfigDb().prepare('SELECT count(*) AS c FROM skill_files').get() as {
        c: number;
      }
    ).c;
    const mirrored = countFiles(skillsCacheDir());
    add(
      'skills mirror',
      rows === mirrored ? 'ok' : 'warn',
      `${mirrored} files mirrored, ${rows} rows`,
    );

    const { listAgents } = await import('../store/agents.js');
    const agents = listAgents();
    const broken = agents.filter((folder) => {
      const link = path.join(agentVarDir(folder), '.claude', 'skills');
      try {
        return (
          !fs.lstatSync(link).isSymbolicLink() ||
          fs.readlinkSync(link) !== '../../../cache/skills'
        );
      } catch {
        return true;
      }
    });
    add(
      'agent skill links',
      broken.length === 0 ? 'ok' : 'warn',
      broken.length === 0
        ? `${agents.length} agents linked`
        : `not linked: ${broken.join(', ')}`,
    );

    // messages.db is created on the first boot, so its absence is a "not
    // started yet", not a fault. The runtime checks all read it.
    try {
      if (!fs.existsSync(path.join(VAR_DIR, 'messages.db'))) {
        add('messages.db', 'warn', 'not created yet (written on first boot)');
      } else {
        const { runDbHealthChecks } = await import('../admin/data.js');
        for (const check of runDbHealthChecks()) {
          add(check.name.toLowerCase(), check.status, check.detail);
        }
      }
    } catch (err) {
      add(
        'health checks',
        'warn',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const secret = path.join(VAR_DIR, 'auth-secret');
  add(
    'auth secret',
    fs.existsSync(secret) ? 'ok' : 'warn',
    fs.existsSync(secret) ? secret : 'not created yet (written on first boot)',
  );

  const creds = path.join(VAR_DIR, 'auth', 'whatsapp', 'creds.json');
  add(
    'whatsapp pairing',
    fs.existsSync(creds) ? 'ok' : 'warn',
    fs.existsSync(creds) ? 'paired' : 'not paired (run bearclaw whatsapp-auth)',
  );

  const { detectLegacyPaths } = await import('../store/import-legacy.js');
  const legacy = detectLegacyPaths(BEARCLAW_HOME);
  const stray = legacy.filter((rel) => rel !== '.env');
  add(
    'legacy files',
    stray.length === 0 ? 'ok' : 'warn',
    stray.length === 0
      ? 'none'
      : `${stray.join(', ')} (run bearclaw migrate-fs)`,
  );
  if (legacy.includes('.env')) {
    add('.env', 'warn', `${path.join(BEARCLAW_HOME, '.env')} is ignored`);
  }

  if (opts.skipServices) {
    add('services', 'warn', 'skipped (--skip-services)');
    return checks;
  }

  if (process.platform === 'darwin') {
    const uid = process.getuid?.() ?? 0;
    for (const label of LABELS) {
      const result = spawnSync('launchctl', ['print', `gui/${uid}/${label}`], {
        encoding: 'utf-8',
      });
      const loaded = result.status === 0;
      const state = /state = (\S+)/.exec(result.stdout ?? '')?.[1];
      add(
        label,
        loaded ? 'ok' : 'warn',
        loaded ? (state ?? 'loaded') : 'not loaded',
      );
    }
  }

  const api = await probe(`http://127.0.0.1:${HTTP_PORT}/api/auth/me`);
  add(
    'http api',
    api === null ? 'fail' : 'ok',
    api === null
      ? `no answer on :${HTTP_PORT}`
      : `:${HTTP_PORT} responded ${api}`,
  );

  const web = await probe('http://127.0.0.1:3030/login');
  add(
    'web ui',
    web === null ? 'warn' : 'ok',
    web === null ? 'no answer on :3030' : `:3030 responded ${web}`,
  );

  return checks;
}

export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  const mark: Record<CheckStatus, string> = {
    ok: 'ok  ',
    warn: 'warn',
    fail: 'FAIL',
  };
  return checks
    .map((c) => `${mark[c.status]}  ${c.name.padEnd(width)}  ${c.detail}`)
    .join('\n');
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<number> {
  const checks = await collectChecks(opts);
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  if (opts.json) {
    console.log(
      JSON.stringify({ ok: failed === 0, failed, warned, checks }, null, 2),
    );
  } else {
    console.log(formatChecks(checks));
    console.log(
      `\n${checks.length} checks, ${failed} failing, ${warned} warning`,
    );
  }
  return failed === 0 ? 0 : 1;
}
