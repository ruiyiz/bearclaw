import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PROJECT_ROOT } from './templates.js';

// A bundle is everything a second machine needs to become this install: the
// config database (secrets included) plus the channel credentials that live
// outside it. Conversations and the message log are opt-in because they are
// large and rarely wanted on a spare machine.

export interface ExportOptions {
  out?: string;
  withConversations?: boolean;
  withMessages?: boolean;
  /** Export a tree other than the running install's. Tests use it. */
  home?: string;
}

export interface ExportManifest {
  version: string;
  createdAt: string;
  schemaVersion: number;
  host: string;
  includes: { conversations: boolean; messages: boolean };
}

function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

export function packageVersion(): string {
  try {
    const raw = fs.readFileSync(
      path.join(PROJECT_ROOT, 'package.json'),
      'utf-8',
    );
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// A live connection cannot simply be copied: better-sqlite3's backup takes a
// consistent snapshot while the main process keeps writing.
async function backupDb(source: string, target: string): Promise<void> {
  const db = new Database(source, { readonly: true });
  try {
    await db.backup(target);
  } finally {
    db.close();
  }
}

export async function runExport(opts: ExportOptions = {}): Promise<number> {
  const paths = await import('../store/paths.js');
  const { schemaVersion } = await import('../store/migrations.js');

  const home = opts.home ? path.resolve(opts.home) : paths.BEARCLAW_HOME;
  const configDbPath = path.join(home, 'bearclaw.db');
  const varDir = path.join(home, 'var');
  if (!fs.existsSync(configDbPath)) {
    console.error(`No config database at ${configDbPath}.`);
    return 1;
  }

  const out = path.resolve(opts.out || `bearclaw-export-${stamp()}.tgz`);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'bearclaw-export-'));

  try {
    const stagedDb = path.join(staging, 'bearclaw.db');
    await backupDb(configDbPath, stagedDb);
    // Read the version off the snapshot: the live connection may belong to
    // another process, or to no process at all.
    const snapshot = new Database(stagedDb, { readonly: true });
    const version = schemaVersion(snapshot);
    snapshot.close();

    const varStage = path.join(staging, 'var');
    fs.mkdirSync(varStage, { recursive: true });

    const authDir = path.join(varDir, 'auth');
    if (fs.existsSync(authDir)) {
      fs.cpSync(authDir, path.join(varStage, 'auth'), { recursive: true });
    }
    const secret = path.join(varDir, 'auth-secret');
    if (fs.existsSync(secret)) {
      fs.copyFileSync(secret, path.join(varStage, 'auth-secret'));
    }

    if (opts.withConversations) {
      const agentsDir = path.join(varDir, 'agents');
      for (const entry of fs.existsSync(agentsDir)
        ? fs.readdirSync(agentsDir, { withFileTypes: true })
        : []) {
        if (!entry.isDirectory()) continue;
        for (const sub of ['conversations', 'checkpoints']) {
          const src = path.join(agentsDir, entry.name, sub);
          if (!fs.existsSync(src)) continue;
          fs.cpSync(src, path.join(varStage, 'agents', entry.name, sub), {
            recursive: true,
          });
        }
      }
    }

    if (opts.withMessages) {
      const messages = path.join(varDir, 'messages.db');
      if (fs.existsSync(messages)) {
        await backupDb(messages, path.join(varStage, 'messages.db'));
      }
    }

    const manifest: ExportManifest = {
      version: packageVersion(),
      createdAt: new Date().toISOString(),
      schemaVersion: version,
      host: os.hostname(),
      includes: {
        conversations: Boolean(opts.withConversations),
        messages: Boolean(opts.withMessages),
      },
    };
    fs.writeFileSync(
      path.join(staging, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const tar = spawnSync('tar', ['-czf', out, '-C', staging, '.'], {
      stdio: 'inherit',
    });
    if (tar.status !== 0) {
      console.error('tar failed');
      return 1;
    }
    fs.chmodSync(out, 0o600);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  const size = fs.statSync(out).size;
  console.log(`Exported ${home}`);
  console.log(`  ${out} (${Math.round(size / 1024)} KB, mode 0600)`);
  console.log('');
  console.log('WARNING: this bundle contains secrets in the clear.');
  console.log('  API tokens, the web password hash, WhatsApp credentials.');
  console.log('  Treat it like a password file: encrypt it before it moves.');
  return 0;
}
