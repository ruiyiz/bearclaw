import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

// BEARCLAW_HOME has to be pointed at the restore target before any store
// module is imported: paths.ts captures it once.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bearclaw-bundle-'));
const homeA = path.join(root, 'a');
const homeB = path.join(root, 'b');
process.env.BEARCLAW_HOME = homeB;
delete process.env.BEARCLAW_PASSWORD;

const { runExport } = await import('./export.js');
const { runImport } = await import('./import.js');
const configDb = await import('../store/config-db.js');
const settings = await import('../store/settings.js');

const bundle = path.join(root, 'bundle.tgz');
const CREDS = JSON.stringify({ registered: true, me: { id: '1@s.whatsapp' } });

before(() => {
  fs.mkdirSync(path.join(homeA, 'var', 'auth', 'whatsapp'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(homeA, 'var', 'auth', 'whatsapp', 'creds.json'),
    CREDS,
  );
  fs.writeFileSync(path.join(homeA, 'var', 'auth-secret'), 'deadbeef');
  configDb.initConfigDb(path.join(homeA, 'bearclaw.db'));
  settings.setSetting('ASSISTANT_NAME', 'Rue');
  settings.setSetting('DEFAULT_MODEL', 'sonnet');
  settings.setPassword('correct horse');
  configDb.closeConfigDb();
});

after(() => {
  configDb.closeConfigDb();
  delete process.env.BEARCLAW_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('export/import round trip', () => {
  it('writes a 0600 bundle with a manifest', async () => {
    assert.equal(await runExport({ home: homeA, out: bundle }), 0);
    assert.equal(fs.statSync(bundle).mode & 0o777, 0o600);

    const listed = spawnSync('tar', ['-tzf', bundle], { encoding: 'utf-8' });
    assert.equal(listed.status, 0);
    assert.ok(listed.stdout.includes('./bearclaw.db'));
    assert.ok(listed.stdout.includes('./var/auth/whatsapp/creds.json'));
    assert.ok(listed.stdout.includes('./var/auth-secret'));

    const shown = spawnSync('tar', ['-xzOf', bundle, './manifest.json'], {
      encoding: 'utf-8',
    });
    const manifest = JSON.parse(shown.stdout) as {
      version: string;
      schemaVersion: number;
      host: string;
      includes: { conversations: boolean; messages: boolean };
    };
    assert.match(manifest.version, /^\d/);
    assert.ok(manifest.schemaVersion >= 1);
    assert.equal(manifest.host, os.hostname());
    assert.deepEqual(manifest.includes, {
      conversations: false,
      messages: false,
    });
  });

  it('restores settings, password and credentials into a fresh home', async () => {
    assert.equal(await runImport(bundle, { skipSetup: true }), 0);

    const dbPath = path.join(homeB, 'bearclaw.db');
    assert.ok(fs.existsSync(dbPath));
    assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
    assert.equal(
      fs.readFileSync(
        path.join(homeB, 'var', 'auth', 'whatsapp', 'creds.json'),
        'utf-8',
      ),
      CREDS,
    );
    assert.equal(
      fs.readFileSync(path.join(homeB, 'var', 'auth-secret'), 'utf-8'),
      'deadbeef',
    );
    assert.equal(fs.existsSync(path.join(homeB, 'manifest.json')), false);

    assert.equal(settings.getSetting('ASSISTANT_NAME'), 'Rue');
    assert.equal(settings.getSetting('DEFAULT_MODEL'), 'sonnet');
    assert.equal(settings.verifyPassword('correct horse'), true);
    assert.equal(settings.verifyPassword('wrong horse'), false);
  });

  it('refuses to overwrite an existing database without --force', async () => {
    assert.equal(await runImport(bundle, { skipSetup: true }), 1);
    assert.equal(
      fs.readdirSync(homeB).filter((f) => f.includes('.bak-')).length,
      0,
    );
  });

  it('moves the old database aside with --force', async () => {
    assert.equal(await runImport(bundle, { skipSetup: true, force: true }), 0);
    const backups = fs.readdirSync(homeB).filter((f) => f.includes('.bak-'));
    assert.equal(backups.length, 1);
    assert.equal(settings.verifyPassword('correct horse'), true);
  });
});
