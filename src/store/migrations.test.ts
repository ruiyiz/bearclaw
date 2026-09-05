import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { after, test } from 'node:test';

import { closeConfigDb, getConfigDb, initConfigDb } from './config-db.js';
import { LATEST_VERSION, runMigrations, schemaVersion } from './migrations.js';

after(() => closeConfigDb());

const TABLES = [
  'settings',
  'agents',
  'context_files',
  'skills',
  'skill_files',
  'skill_sources',
  'mcp_servers',
  'model_catalog',
  'workflow_definitions',
];

test('a fresh database reaches the latest schema version', () => {
  const db = new Database(':memory:');
  assert.equal(schemaVersion(db), 0);
  assert.equal(runMigrations(db), LATEST_VERSION);

  const names = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  for (const table of TABLES)
    assert.ok(names.includes(table), `missing ${table}`);
  db.close();
});

test('re-running migrations is a no-op', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    'INSERT INTO settings (key, value, secret, updated_at) VALUES (?, ?, 0, ?)',
  ).run('KEEP', 'me', new Date().toISOString());
  assert.equal(runMigrations(db), LATEST_VERSION);
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('KEEP');
  assert.deepEqual(row, { value: 'me' });
  db.close();
});

test('a database from a newer build is refused', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  db.pragma(`user_version = ${LATEST_VERSION + 5}`);
  assert.throws(() => runMigrations(db), /only knows v1/);
  db.close();
});

test('initConfigDb opens the schema and sets pragmas', () => {
  const db = initConfigDb(':memory:');
  assert.equal(schemaVersion(db), LATEST_VERSION);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(getConfigDb(), db);
  // Same path returns the same connection rather than reopening.
  assert.equal(initConfigDb(':memory:'), db);
});
