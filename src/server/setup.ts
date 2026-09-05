import fs from 'node:fs';
import path from 'node:path';

import {
  IDENTITY_TEMPLATE,
  loadContextTemplate,
  loadTemplate,
} from '../cli/templates.js';
import { MODELS } from '../models.js';
import { AUTH_DIR } from '../store/paths.js';
import {
  getSetting,
  hasPassword,
  isInternalKey,
  isOnboarded,
} from '../store/settings.js';

// Everything the first-run wizard needs to decide which steps to show. The
// status route is public — a browser hits it before any password exists — so
// nothing here may return a secret value, only whether one is present.

export const MIN_PASSWORD_LENGTH = 8;

export const DEFAULT_ASSISTANT_NAME = 'Andy';

export interface SetupModel {
  id: string;
  alias: string;
  short?: string;
  label: string;
  contextWindow: number;
}

export interface SetupStatus {
  onboarded: boolean;
  hasPassword: boolean;
  hasClaudeAuth: boolean;
  hasModel: boolean;
  assistantName: string;
  timezone: string;
  model: string;
  models: SetupModel[];
  whatsapp: { paired: boolean };
  telegram: { configured: boolean };
  templates: { USER: string; SOUL: string; IDENTITY: string };
}

// The database is the wizard's own scratchpad: a value it just wrote is not in
// process.env yet (env is loaded once at boot), so the row wins here.
function settingOrEnv(key: string): string {
  return getSetting(key) || process.env[key] || '';
}

// A checkout missing templates/ must not break the wizard: the editors just
// start empty.
function safeTemplate(load: () => string): string {
  try {
    return load();
  } catch {
    return '';
  }
}

export function whatsappPaired(): boolean {
  return fs.existsSync(path.join(AUTH_DIR, 'whatsapp', 'creds.json'));
}

export function buildSetupStatus(): SetupStatus {
  const assistantName =
    settingOrEnv('ASSISTANT_NAME') || DEFAULT_ASSISTANT_NAME;
  const vars = { ASSISTANT_NAME: assistantName };
  const model = settingOrEnv('DEFAULT_MODEL');
  return {
    onboarded: isOnboarded(),
    hasPassword: hasPassword(),
    hasClaudeAuth: Boolean(
      settingOrEnv('CLAUDE_CODE_OAUTH_TOKEN') ||
      settingOrEnv('ANTHROPIC_API_KEY'),
    ),
    hasModel: Boolean(model),
    assistantName,
    timezone:
      settingOrEnv('TZ') ||
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      'UTC',
    model,
    models: MODELS.map((m) => ({
      id: m.id,
      alias: m.alias,
      short: m.short,
      label: m.label,
      contextWindow: m.contextWindow,
    })),
    whatsapp: { paired: whatsappPaired() },
    telegram: { configured: Boolean(settingOrEnv('TELEGRAM_BOT_TOKEN')) },
    templates: {
      USER: safeTemplate(() => loadContextTemplate('USER.md', vars)),
      SOUL: safeTemplate(() => loadContextTemplate('SOUL.md', vars)),
      IDENTITY: safeTemplate(() => loadTemplate(IDENTITY_TEMPLATE, vars)),
    },
  };
}

/** Null when acceptable, otherwise the reason to show the caller. */
export function validateNewPassword(password: unknown): string | null {
  if (typeof password !== 'string' || !password) return 'missing password';
  if (password.length < MIN_PASSWORD_LENGTH)
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  return null;
}

const SETTING_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Null when the key may be written through the settings API. */
export function validateSettingKey(key: string): string | null {
  if (!key) return 'missing key';
  if (isInternalKey(key)) return `${key} is managed by BearClaw`;
  if (!SETTING_KEY.test(key)) return `invalid key: ${key}`;
  return null;
}
