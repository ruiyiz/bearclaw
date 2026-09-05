import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { ExportManifest } from './export.js';

// Restores a bundle onto a machine. Everything machine-local (launchd agents,
// builds, services) is re-derived by the setup flow afterwards, because those
// paths belong to this machine and not to the bundle.

export interface ImportBundleOptions {
  force?: boolean;
  skipSetup?: boolean;
  launchAgentsDir?: string;
  skipWeb?: boolean;
  skipServices?: boolean;
  skipBuild?: boolean;
}

function backupName(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  return `${dbPath}.bak-${stamp}`;
}

function chmodIfPresent(file: string, mode: number): void {
  try {
    fs.chmodSync(file, mode);
  } catch {
    // absent or not ours
  }
}

export async function runImport(
  bundle: string,
  opts: ImportBundleOptions = {},
): Promise<number> {
  const resolved = path.resolve(bundle);
  if (!fs.existsSync(resolved)) {
    console.error(`No such bundle: ${resolved}`);
    return 1;
  }

  // paths.ts only reads env, so importing it here does not open anything.
  const { BEARCLAW_HOME, CONFIG_DB_PATH, VAR_DIR } =
    await import('../store/paths.js');

  // Nothing may hold the file we are about to replace.
  const { closeConfigDb, initConfigDb } = await import('../store/config-db.js');
  closeConfigDb();

  if (fs.existsSync(CONFIG_DB_PATH)) {
    if (!opts.force) {
      console.error(`${CONFIG_DB_PATH} already exists.`);
      console.error('Pass --force to move it aside and restore over it.');
      return 1;
    }
    const backup = backupName(CONFIG_DB_PATH);
    fs.renameSync(CONFIG_DB_PATH, backup);
    console.log(`Moved the existing database to ${backup}`);
  }

  fs.mkdirSync(BEARCLAW_HOME, { recursive: true });
  const tar = spawnSync('tar', ['-xzf', resolved, '-C', BEARCLAW_HOME], {
    stdio: 'inherit',
  });
  if (tar.status !== 0) {
    console.error('tar failed');
    return 1;
  }

  const manifestPath = path.join(BEARCLAW_HOME, 'manifest.json');
  let manifest: ExportManifest | null = null;
  try {
    manifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf-8'),
    ) as ExportManifest;
    fs.rmSync(manifestPath, { force: true });
  } catch {
    console.log('warn  the bundle has no manifest.json');
  }

  chmodIfPresent(CONFIG_DB_PATH, 0o600);
  chmodIfPresent(path.join(VAR_DIR, 'auth-secret'), 0o600);
  chmodIfPresent(path.join(VAR_DIR, 'messages.db'), 0o600);

  const { LATEST_VERSION, schemaVersion } =
    await import('../store/migrations.js');
  const db = initConfigDb(CONFIG_DB_PATH);
  const version = schemaVersion(db);

  const { loadSettingsIntoEnv } = await import('../store/settings.js');
  loadSettingsIntoEnv();

  const { ensureVarLayout } = await import('../store/bootstrap.js');
  ensureVarLayout();
  const { ensureAgentVarLayout, materializeAll } =
    await import('../store/materialize.js');
  const { listAgents } = await import('../store/agents.js');
  materializeAll();
  for (const folder of listAgents()) ensureAgentVarLayout(folder);

  console.log(`Restored into ${BEARCLAW_HOME}`);
  if (manifest) {
    console.log(
      `  bundle from ${manifest.host}, BearClaw ${manifest.version}, ${manifest.createdAt}`,
    );
  }
  console.log(`  schema v${version} of v${LATEST_VERSION}`);
  console.log(`  ${listAgents().length} agents, mirrors rebuilt`);

  if (opts.skipSetup) {
    console.log('\nSkipped the machine-local setup (--skip-setup).');
    console.log('Run `bearclaw setup` before starting the services.');
    return 0;
  }

  console.log('\nRunning setup for the machine-local parts...');
  const { runSetup } = await import('./setup.js');
  return runSetup({
    yes: true,
    launchAgentsDir: opts.launchAgentsDir,
    skipWeb: opts.skipWeb,
    skipServices: opts.skipServices,
    skipBuild: opts.skipBuild,
  });
}
