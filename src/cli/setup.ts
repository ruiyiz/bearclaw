import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bootstrap } from '../store/bootstrap.js';
import { Prompter, generatePassword } from './prompt.js';
import { launchAgentsDir, machineEnv, writeLaunchAgents } from './plist.js';
import {
  CONTEXT_TEMPLATES,
  IDENTITY_TEMPLATE,
  PROJECT_ROOT,
  loadContextTemplate,
  loadTemplate,
} from './templates.js';

// `bearclaw setup` is the whole install path: it fills the config database,
// renders the launchd agents, builds both halves and starts the services. It
// is idempotent by design, so an existing install can rerun it after a pull.

export interface SetupOptions {
  yes?: boolean;
  generate?: boolean;
  skipWeb?: boolean;
  skipServices?: boolean;
  skipBuild?: boolean;
  launchAgentsDir?: string;
}

const HTTP_PORT = process.env.BEARCLAW_HTTP_PORT || '7878';
const HTTP_URL = `http://127.0.0.1:${HTTP_PORT}/api/auth/me`;
const WEB_URL = 'http://127.0.0.1:3030';

function step(n: number, title: string): void {
  console.log(`\n[${n}] ${title}`);
}

function has(command: string): boolean {
  return spawnSync('which', [command], { stdio: 'ignore' }).status === 0;
}

function run(command: string, args: string[], cwd: string): boolean {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  return result.status === 0;
}

function nodeMajor(): number {
  return Number(process.versions.node.split('.')[0]);
}

async function pollHttp(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HTTP_URL);
      if (res.status < 500) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

export async function runSetup(opts: SetupOptions = {}): Promise<number> {
  const prompter = new Prompter(opts.yes ?? false);
  try {
    return await setup(opts, prompter);
  } finally {
    prompter.close();
  }
}

async function setup(opts: SetupOptions, ask: Prompter): Promise<number> {
  console.log('BearClaw setup');

  step(1, 'Prerequisites');
  if (nodeMajor() < 20) {
    console.error(`  Node ${process.versions.node} is too old: 20 or newer.`);
    return 1;
  }
  console.log(`  ok    node ${process.versions.node}`);
  if (has('claude')) {
    console.log('  ok    claude CLI on PATH');
  } else {
    console.log(
      '  warn  claude CLI not on PATH (install it for `claude setup-token`)',
    );
  }

  step(2, 'Config database');
  bootstrap();
  const { BEARCLAW_HOME, CONFIG_DB_PATH } = await import('../store/paths.js');
  const { schemaVersion } = await import('../store/migrations.js');
  const { getConfigDb } = await import('../store/config-db.js');
  console.log(`  home  ${BEARCLAW_HOME}`);
  console.log(
    `  db    ${CONFIG_DB_PATH} (schema v${schemaVersion(getConfigDb())})`,
  );

  const settings = await import('../store/settings.js');
  const { detectLegacyPaths, importLegacyFs } =
    await import('../store/import-legacy.js');

  step(3, 'Legacy files');
  const legacy = detectLegacyPaths(BEARCLAW_HOME);
  if (legacy.length === 0) {
    console.log('  none found');
  } else {
    console.log(`  found ${legacy.join(', ')}`);
    const go =
      opts.yes ||
      (await ask.confirm('  Import them into the config database?', true));
    if (go) {
      const report = importLegacyFs({});
      console.log(
        `  imported ${report.settings.length} settings, ${report.agents.length} agents, ` +
          `${report.contextFiles.length} context files, ${report.skills.length} skills, ` +
          `${report.workflows.length} workflows`,
      );
      if (report.legacyDir) console.log(`  originals at ${report.legacyDir}`);
      settings.loadSettingsIntoEnv();
    } else {
      console.log('  skipped (run `bearclaw migrate-fs` later)');
    }
  }

  step(4, 'Claude authentication');
  const authKeys = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
  let hasAuth = authKeys.some(
    (key) => process.env[key] || settings.getSetting(key),
  );
  if (hasAuth) {
    console.log('  ok    already configured');
  } else if (!ask.interactive) {
    console.log('  warn  no token configured (set one before starting)');
  } else {
    console.log('  Run `claude setup-token` in another terminal, or paste an');
    console.log('  Anthropic API key.');
    const kind = await ask.ask(
      '  Which do you have? (token/key/skip)',
      'token',
    );
    if (kind === 'token' || kind === 'key') {
      const value = await ask.secret('  Paste it');
      if (value) {
        const key = kind === 'key' ? 'ANTHROPIC_API_KEY' : authKeys[0];
        settings.setSetting(key, value, { secret: true });
        process.env[key] = value;
        hasAuth = true;
        console.log(`  ok    ${key} stored`);
      } else {
        console.log('  warn  nothing pasted, skipping');
      }
    } else {
      console.log('  skipped');
    }
  }

  step(5, 'Model');
  const { MODELS, resolveModelAlias } = await import('../models.js');
  const currentModel = settings.getSetting('DEFAULT_MODEL_TIER');
  if (currentModel) {
    console.log(`  ok    DEFAULT_MODEL_TIER=${currentModel}`);
  } else {
    console.log(`  choices: ${MODELS.map((m) => m.alias).join(', ')}`);
    const alias = await ask.ask('  Default model tier', 'default');
    const id = resolveModelAlias(alias) ?? resolveModelAlias('default');
    if (!id) {
      console.error(`  unknown model: ${alias}`);
      return 1;
    }
    settings.setSetting('DEFAULT_MODEL_TIER', id);
    process.env.DEFAULT_MODEL_TIER = id;
    console.log(`  ok    DEFAULT_MODEL_TIER=${id}`);
  }

  step(6, 'Identity');
  const assistantName =
    settings.getSetting('ASSISTANT_NAME') ||
    (await ask.ask('  Assistant name', 'Andy'));
  settings.setSetting('ASSISTANT_NAME', assistantName);
  process.env.ASSISTANT_NAME = assistantName;
  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const tz =
    settings.getSetting('TZ') || (await ask.ask('  Timezone', systemTz));
  settings.setSetting('TZ', tz);
  console.log(`  ok    ${assistantName}, ${tz}`);

  step(7, 'Web password');
  if (settings.getSetting(settings.PASSWORD_HASH_KEY)) {
    console.log('  ok    already set (use the web UI to change it)');
  } else if (opts.generate || !ask.interactive) {
    const generated = generatePassword();
    settings.setPassword(generated);
    console.log('  ok    generated. Save it now, it is not shown again:');
    console.log(`\n      ${generated}\n`);
  } else {
    let stored = false;
    for (let attempt = 0; attempt < 3 && !stored; attempt++) {
      const first = await ask.secret('  New password');
      if (!first) {
        console.log('  empty, try again');
        continue;
      }
      const second = await ask.secret('  Repeat it');
      if (first !== second) {
        console.log('  they differ, try again');
        continue;
      }
      settings.setPassword(first);
      stored = true;
      console.log('  ok    stored');
    }
    if (!stored) {
      console.error('  no password set: rerun setup or use --generate');
      return 1;
    }
  }

  step(8, 'Starter context');
  const { getContextFile, writeContextFile } =
    await import('../store/context.js');
  const { agentExists, createAgent } = await import('../store/agents.js');
  const vars = { ASSISTANT_NAME: assistantName };
  for (const name of CONTEXT_TEMPLATES) {
    if (getContextFile('shared', null, name) !== undefined) {
      console.log(`  keep  ${name}`);
      continue;
    }
    writeContextFile('shared', null, name, loadContextTemplate(name, vars));
    console.log(`  seed  ${name}`);
  }
  // createAgent leaves a stub IDENTITY.md behind, so a folder created here
  // takes the template over it. An existing one is never touched.
  const freshMain = !agentExists('main');
  if (freshMain) {
    createAgent('main', assistantName);
    console.log('  seed  agent main');
  }
  if (
    freshMain ||
    getContextFile('agent', 'main', 'IDENTITY.md') === undefined
  ) {
    writeContextFile(
      'agent',
      'main',
      'IDENTITY.md',
      loadTemplate(IDENTITY_TEMPLATE, vars),
    );
    console.log('  seed  main/IDENTITY.md');
  } else {
    console.log('  keep  main/IDENTITY.md');
  }

  step(9, 'Mirrors');
  const { ensureAgentVarLayout, materializeAll } =
    await import('../store/materialize.js');
  materializeAll();
  const { listAgents } = await import('../store/agents.js');
  for (const folder of listAgents()) ensureAgentVarLayout(folder);
  console.log(`  ok    var/cache rebuilt for ${listAgents().length} agents`);

  step(10, 'launchd agents');
  const targetDir = opts.launchAgentsDir ?? launchAgentsDir();
  const extraEnv = machineEnv();
  const agents = writeLaunchAgents({ targetDir, extraEnv });
  for (const agent of agents) console.log(`  wrote ${agent.target}`);
  if (Object.keys(extraEnv).length > 0) {
    console.log(`  env   ${Object.keys(extraEnv).join(', ')}`);
  }

  step(11, 'Build');
  if (opts.skipBuild) {
    console.log('  skipped (--skip-build)');
  } else if (!run('npm', ['run', 'build'], PROJECT_ROOT)) {
    console.error('  npm run build failed');
    return 1;
  }
  const webDir = path.join(PROJECT_ROOT, 'web');
  if (opts.skipWeb) {
    console.log('  web skipped (--skip-web)');
  } else if (!has('bun')) {
    console.log('  warn  bun not on PATH: skipping the web build');
    console.log(
      '        install bun, then `cd web && bun install && bun run build`',
    );
  } else if (
    !run('bun', ['install'], webDir) ||
    !run('bun', ['run', 'build'], webDir)
  ) {
    console.error('  web build failed');
    return 1;
  }

  step(12, 'Services');
  if (opts.skipServices) {
    console.log('  skipped (--skip-services)');
  } else if (process.platform !== 'darwin') {
    console.log('  skipped (launchd is macOS only)');
  } else {
    const uid = process.getuid?.() ?? 0;
    for (const agent of agents) {
      if (!fs.existsSync(agent.target)) continue;
      spawnSync('launchctl', ['bootout', `gui/${uid}/${agent.label}`], {
        stdio: 'ignore',
      });
      const result = spawnSync(
        'launchctl',
        ['bootstrap', `gui/${uid}`, agent.target],
        { stdio: 'inherit' },
      );
      console.log(
        `  ${result.status === 0 ? 'ok   ' : 'fail '} ${agent.label}`,
      );
    }
    console.log('  waiting for the API...');
    console.log(
      (await pollHttp())
        ? '  ok    API responding'
        : '  warn  API silent after 30s (see logs/)',
    );
  }

  step(13, 'Done');
  const ready =
    hasAuth &&
    Boolean(settings.getSetting('DEFAULT_MODEL')) &&
    Boolean(settings.getSetting(settings.PASSWORD_HASH_KEY));
  if (ready && !settings.isOnboarded()) settings.setOnboarded();
  console.log(
    ready
      ? `  Open ${WEB_URL}`
      : `  Finish the remaining steps at ${WEB_URL}/setup`,
  );
  console.log('  Check anything that looks off with `bearclaw doctor`.');
  if (os.platform() === 'darwin' && !opts.skipServices) {
    console.log('  Logs: logs/bearclaw.log, logs/bearclaw.web.log');
  }
  return 0;
}
