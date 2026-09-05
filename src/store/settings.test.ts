import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

import { closeConfigDb, getConfigDb, initConfigDb } from './config-db.js';
import {
  deleteSetting,
  getSetting,
  hasPassword,
  isOnboarded,
  isSecretKey,
  listSettings,
  loadSettingsIntoEnv,
  setOnboarded,
  setPassword,
  setSetting,
  verifyPassword,
} from './settings.js';

initConfigDb(':memory:');
after(() => closeConfigDb());

beforeEach(() => {
  getConfigDb().exec('DELETE FROM settings');
  delete process.env.BEARCLAW_PASSWORD;
});

test('isSecretKey matches the token/key/password/secret families', () => {
  for (const key of [
    'TELEGRAM_BOT_TOKEN',
    'OPENAI_API_KEY',
    'BEARCLAW_PASSWORD',
    'SOME_SECRET',
  ]) {
    assert.ok(isSecretKey(key), key);
  }
  for (const key of ['ASSISTANT_NAME', 'DEFAULT_MODEL', 'TZ']) {
    assert.ok(!isSecretKey(key), key);
  }
});

test('set/get/delete round-trip', () => {
  setSetting('ASSISTANT_NAME', 'Andy');
  assert.equal(getSetting('ASSISTANT_NAME'), 'Andy');
  setSetting('ASSISTANT_NAME', 'Bear');
  assert.equal(getSetting('ASSISTANT_NAME'), 'Bear');
  assert.equal(deleteSetting('ASSISTANT_NAME'), true);
  assert.equal(getSetting('ASSISTANT_NAME'), undefined);
  assert.equal(deleteSetting('ASSISTANT_NAME'), false);
});

test('listSettings redacts secrets by default and hides internal keys', () => {
  setSetting('ASSISTANT_NAME', 'Andy');
  setSetting('OPENAI_API_KEY', 'sk-abcdefgh');
  setOnboarded();

  const redacted = listSettings();
  assert.deepEqual(
    redacted.map((r) => r.key),
    ['ASSISTANT_NAME', 'OPENAI_API_KEY'],
  );
  const secretRow = redacted.find((r) => r.key === 'OPENAI_API_KEY')!;
  assert.equal(secretRow.secret, true);
  assert.ok(!secretRow.value.includes('sk-abc'));
  assert.ok(secretRow.value.endsWith('efgh'));

  const plain = listSettings({ redact: false });
  assert.equal(
    plain.find((r) => r.key === 'OPENAI_API_KEY')?.value,
    'sk-abcdefgh',
  );

  const withInternal = listSettings({ includeInternal: true });
  assert.ok(withInternal.some((r) => r.key === 'bearclaw.onboarded'));
});

test('loadSettingsIntoEnv leaves env alone and never exports internal keys', () => {
  setSetting('TZ', 'Europe/Zurich');
  setSetting('ASSISTANT_NAME', 'Bear');
  setPassword('hunter2');
  setOnboarded();

  process.env.TZ = 'UTC';
  delete process.env.ASSISTANT_NAME;

  const applied = loadSettingsIntoEnv();
  assert.equal(process.env.TZ, 'UTC');
  assert.equal(process.env.ASSISTANT_NAME, 'Bear');
  assert.deepEqual(applied, ['ASSISTANT_NAME']);
  assert.equal(process.env['bearclaw.password_hash'], undefined);
  assert.equal(process.env['bearclaw.onboarded'], undefined);

  delete process.env.ASSISTANT_NAME;
});

test('onboarded flag defaults off', () => {
  assert.equal(isOnboarded(), false);
  setOnboarded();
  assert.equal(isOnboarded(), true);
  setOnboarded(false);
  assert.equal(isOnboarded(), false);
});

test('password hashing verifies the right password only', () => {
  assert.equal(hasPassword(), false);
  assert.equal(verifyPassword('anything'), false);

  setPassword('correct horse');
  assert.equal(hasPassword(), true);
  assert.equal(verifyPassword('correct horse'), true);
  assert.equal(verifyPassword('correct hors'), false);
  assert.equal(verifyPassword(''), false);

  const stored = getSetting('bearclaw.password_hash')!;
  assert.ok(stored.startsWith('scrypt$'));
  assert.ok(!stored.includes('correct horse'));
  assert.throws(() => setPassword(''), /empty/);
});

test('BEARCLAW_PASSWORD in the environment wins over the stored hash', () => {
  setPassword('stored-one');
  process.env.BEARCLAW_PASSWORD = 'env-one';
  assert.equal(hasPassword(), true);
  assert.equal(verifyPassword('env-one'), true);
  assert.equal(verifyPassword('stored-one'), false);
  delete process.env.BEARCLAW_PASSWORD;
  assert.equal(verifyPassword('stored-one'), true);
});
