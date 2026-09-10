import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// paths.ts freezes BEARCLAW_HOME at import, so the temp home has to be
// exported before anything under src/store is loaded.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bearclaw-setup-'));
process.env.BEARCLAW_HOME = home;
delete process.env.BEARCLAW_PASSWORD;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.DEFAULT_MODEL;
delete process.env.ASSISTANT_NAME;
delete process.env.TELEGRAM_BOT_TOKEN;

const { closeConfigDb, getConfigDb, initConfigDb } =
  await import('../store/config-db.js');
initConfigDb(path.join(home, 'bearclaw.db'));
const { setOnboarded, setPassword, setSetting } =
  await import('../store/settings.js');
const {
  MIN_PASSWORD_LENGTH,
  buildSetupStatus,
  passwordRouteOpen,
  validateNewPassword,
  validateSettingKey,
} = await import('./setup.js');

after(() => {
  closeConfigDb();
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  getConfigDb().exec('DELETE FROM settings');
});

test('status on a fresh install asks for everything', () => {
  const s = buildSetupStatus();
  assert.equal(s.onboarded, false);
  assert.equal(s.hasPassword, false);
  assert.equal(s.hasClaudeAuth, false);
  assert.equal(s.hasModel, false);
  assert.equal(s.assistantName, 'Andy');
  assert.equal(s.whatsapp.paired, false);
  assert.equal(s.telegram.configured, false);
  assert.ok(s.models.length > 0);
  assert.ok(s.models.some((m) => m.alias === 'default'));
  assert.ok(s.timezone.length > 0);
});

test('status reports presence without leaking any secret value', () => {
  setPassword('correct horse battery');
  setSetting('CLAUDE_CODE_OAUTH_TOKEN', 'sk-oauth-supersecret');
  setSetting('TELEGRAM_BOT_TOKEN', '12345:telegram-supersecret');
  setSetting('DEFAULT_MODEL', 'sonnet');
  setSetting('ASSISTANT_NAME', 'Bruno');

  const s = buildSetupStatus();
  assert.equal(s.hasPassword, true);
  assert.equal(s.hasClaudeAuth, true);
  assert.equal(s.hasModel, true);
  assert.equal(s.model, 'sonnet');
  assert.equal(s.assistantName, 'Bruno');
  assert.equal(s.telegram.configured, true);

  const blob = JSON.stringify(s);
  assert.ok(!blob.includes('supersecret'));
  assert.ok(!blob.includes('correct horse battery'));
  assert.ok(!blob.includes('password_hash'));
});

test('templates render with the configured assistant name', () => {
  setSetting('ASSISTANT_NAME', 'Bruno');
  const s = buildSetupStatus();
  assert.ok(s.templates.IDENTITY.includes('Bruno'));
  assert.ok(!s.templates.IDENTITY.includes('{{ASSISTANT_NAME}}'));
  assert.ok(s.templates.USER.length > 0);
  assert.ok(s.templates.SOUL.length > 0);
});

test('password route closes as soon as a password exists', () => {
  assert.equal(passwordRouteOpen(), true);
  setPassword('first-password');
  assert.equal(passwordRouteOpen(), false);
  assert.equal(buildSetupStatus().onboarded, false);
  setOnboarded();
  assert.equal(passwordRouteOpen(), false);
});

test('onboarded flag flips once setup completes', () => {
  assert.equal(buildSetupStatus().onboarded, false);
  setOnboarded();
  assert.equal(buildSetupStatus().onboarded, true);
});

test('password must be present and long enough', () => {
  assert.equal(validateNewPassword(undefined), 'missing password');
  assert.equal(validateNewPassword(''), 'missing password');
  assert.equal(validateNewPassword(42), 'missing password');
  assert.ok(validateNewPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1)));
  assert.equal(validateNewPassword('a'.repeat(MIN_PASSWORD_LENGTH)), null);
});

test('settings keys are env names and never internal bookkeeping', () => {
  assert.equal(validateSettingKey('TELEGRAM_BOT_TOKEN'), null);
  assert.equal(validateSettingKey('_private'), null);
  assert.ok(validateSettingKey(''));
  assert.ok(validateSettingKey('bearclaw.onboarded'));
  assert.ok(validateSettingKey('bearclaw.password_hash'));
  assert.ok(validateSettingKey('has space'));
  assert.ok(validateSettingKey('1LEADING_DIGIT'));
});
