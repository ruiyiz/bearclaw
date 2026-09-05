import crypto from 'node:crypto';

import { getConfigDb, tryGetConfigDb } from './config-db.js';

export interface SettingRow {
  key: string;
  value: string;
  secret: boolean;
  updated_at: string;
}

// Keys under this prefix are BearClaw's own bookkeeping. They never reach
// process.env and never show up as environment settings.
const INTERNAL_PREFIX = 'bearclaw.';

export const PASSWORD_HASH_KEY = 'bearclaw.password_hash';
export const ONBOARDED_KEY = 'bearclaw.onboarded';

const SECRET_KEY_PATTERN = /(TOKEN|KEY|PASSWORD|SECRET)/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function isInternalKey(key: string): boolean {
  return key.startsWith(INTERNAL_PREFIX);
}

function nowIso(): string {
  return new Date().toISOString();
}

// Reads tolerate a closed database so request paths (auth) and CLI help can run
// before bootstrap. Writes do not: they are always deliberate.
export function getSetting(key: string): string | undefined {
  const db = tryGetConfigDb();
  if (!db) return undefined;
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(
  key: string,
  value: string,
  opts: { secret?: boolean } = {},
): void {
  const secret = opts.secret ?? isSecretKey(key);
  getConfigDb()
    .prepare(
      `INSERT INTO settings (key, value, secret, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         secret = excluded.secret,
         updated_at = excluded.updated_at`,
    )
    .run(key, value, secret ? 1 : 0, nowIso());
}

export function deleteSetting(key: string): boolean {
  const info = getConfigDb()
    .prepare('DELETE FROM settings WHERE key = ?')
    .run(key);
  return info.changes > 0;
}

export function listSettings(
  opts: { redact?: boolean; includeInternal?: boolean } = {},
): SettingRow[] {
  const db = tryGetConfigDb();
  if (!db) return [];
  const redact = opts.redact ?? true;
  const rows = db
    .prepare('SELECT key, value, secret, updated_at FROM settings ORDER BY key')
    .all() as {
    key: string;
    value: string;
    secret: number;
    updated_at: string;
  }[];
  return rows
    .filter((r) => (opts.includeInternal ? true : !isInternalKey(r.key)))
    .map((r) => ({
      key: r.key,
      value: redact && r.secret ? redactedValue(r.value) : r.value,
      secret: r.secret === 1,
      updated_at: r.updated_at,
    }));
}

function redactedValue(value: string): string {
  if (!value) return '';
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}

// Env wins: a value the operator exported (or a plist set) always beats the
// database, so a broken setting can be overridden without touching SQLite.
export function loadSettingsIntoEnv(): string[] {
  const applied: string[] = [];
  for (const row of listSettings({ redact: false })) {
    if (row.key in process.env) continue;
    process.env[row.key] = row.value;
    applied.push(row.key);
  }
  return applied;
}

// ─── Onboarding ─────────────────────────────────────────────────────────────

export function isOnboarded(): boolean {
  return getSetting(ONBOARDED_KEY) === '1';
}

export function setOnboarded(value = true): void {
  setSetting(ONBOARDED_KEY, value ? '1' : '0', { secret: false });
}

// ─── Password ───────────────────────────────────────────────────────────────

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

function scryptHash(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = scryptHash(password, salt);
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export function setPassword(password: string): void {
  if (!password) throw new Error('password must not be empty');
  setSetting(PASSWORD_HASH_KEY, hashPassword(password), { secret: true });
}

export function hasPassword(): boolean {
  if (process.env.BEARCLAW_PASSWORD) return true;
  return Boolean(getSetting(PASSWORD_HASH_KEY));
}

function verifyHash(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  let derived: Buffer;
  try {
    derived = crypto.scryptSync(
      password,
      Buffer.from(saltB64, 'base64'),
      Buffer.from(hashB64, 'base64').length,
      {
        N: Number(n),
        r: Number(r),
        p: Number(p),
        maxmem: 64 * 1024 * 1024,
      },
    );
  } catch {
    return false;
  }
  const expected = Buffer.from(hashB64, 'base64');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

// BEARCLAW_PASSWORD wins over the stored hash, matching loadSettingsIntoEnv.
export function verifyPassword(password: string): boolean {
  if (!password) return false;
  const env = process.env.BEARCLAW_PASSWORD;
  if (env) {
    const a = Buffer.from(password);
    const b = Buffer.from(env);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const stored = getSetting(PASSWORD_HASH_KEY);
  if (!stored) return false;
  return verifyHash(password, stored);
}
