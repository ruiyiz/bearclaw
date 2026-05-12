import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';

import { CONFIG_DIR, VAR_DIR } from '../config.js';
import { logger } from '../logger.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const SECRET_PATH = path.join(VAR_DIR, 'auth-secret');
const INITIAL_PW_PATH = path.join(VAR_DIR, 'initial-password');
const SESSION_TTL_S = 60 * 60 * 24 * 30; // 30 days
const SESSION_COOKIE = 'nc_session';
const CSRF_COOKIE = 'nc_csrf';
const CSRF_HEADER = 'x-csrf-token';

let SECRET: Buffer;

interface SessionPayload {
  exp: number;
  csrf: string;
  // Reserved for future role split (admin vs user). Not enforced yet.
  role?: 'owner';
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

export function initAuth(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (fs.existsSync(SECRET_PATH)) {
    SECRET = fs.readFileSync(SECRET_PATH);
  } else {
    SECRET = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_PATH, SECRET, { mode: 0o600 });
    logger.info({ path: SECRET_PATH }, 'Generated auth secret');
  }

  // Bootstrap a one-time password if NANOCLAW_PASSWORD is unset and no
  // password file exists yet. Owner reads it from the file/log, logs in,
  // and is expected to set NANOCLAW_PASSWORD in ~/.nanoclaw/.env afterwards.
  if (!process.env.NANOCLAW_PASSWORD && !fs.existsSync(INITIAL_PW_PATH)) {
    const pw = crypto.randomBytes(16).toString('base64url');
    fs.writeFileSync(INITIAL_PW_PATH, pw, { mode: 0o600 });
    logger.warn(
      { path: INITIAL_PW_PATH },
      `INITIAL ADMIN PASSWORD: ${pw}  (write to ~/.nanoclaw/.env as NANOCLAW_PASSWORD then delete the file)`,
    );
  }
}

function expectedPassword(): string | null {
  const env = process.env.NANOCLAW_PASSWORD;
  if (env) return env;
  if (fs.existsSync(INITIAL_PW_PATH)) {
    return fs.readFileSync(INITIAL_PW_PATH, 'utf-8').trim();
  }
  return null;
}

// ─── Token sign/verify ──────────────────────────────────────────────────────

function sign(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SECRET)
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

function verify(token: string): SessionPayload | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(body)
    .digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  let data: SessionPayload;
  try {
    data = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (!data.exp || data.exp < nowS()) return null;
  if (!data.csrf) return null;
  return data;
}

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

// ─── Cookies ────────────────────────────────────────────────────────────────

export function parseCookies(
  req: http.IncomingMessage,
): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setCookies(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  cookies: Array<{ name: string; value: string; httpOnly?: boolean }>,
): void {
  const secure = isSecureRequest(req);
  const lines = cookies.map(({ name, value, httpOnly }) =>
    [
      `${name}=${encodeURIComponent(value)}`,
      'Path=/',
      `Max-Age=${SESSION_TTL_S}`,
      'SameSite=Lax',
      httpOnly !== false ? 'HttpOnly' : '',
      secure ? 'Secure' : '',
    ]
      .filter(Boolean)
      .join('; '),
  );
  res.setHeader('set-cookie', lines);
}

function isSecureRequest(req: http.IncomingMessage): boolean {
  const xfp = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  if (xfp === 'https') return true;
  return Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

// ─── Login / logout / me ────────────────────────────────────────────────────

export interface LoginResult {
  ok: boolean;
  error?: string;
}

export function handleLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: { password?: string },
): LoginResult {
  const expected = expectedPassword();
  if (!expected) {
    return { ok: false, error: 'auth not configured' };
  }
  const supplied = body.password || '';
  // timing-safe compare
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'bad password' };
  }
  const csrf = crypto.randomBytes(24).toString('base64url');
  const token = sign({ exp: nowS() + SESSION_TTL_S, csrf, role: 'owner' });
  setCookies(res, req, [
    { name: SESSION_COOKIE, value: token, httpOnly: true },
    { name: CSRF_COOKIE, value: csrf, httpOnly: false },
  ]);
  return { ok: true };
}

export function handleLogout(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const secure = isSecureRequest(req);
  const expire = (name: string, httpOnly: boolean) =>
    [
      `${name}=`,
      'Path=/',
      'Max-Age=0',
      'SameSite=Lax',
      httpOnly ? 'HttpOnly' : '',
      secure ? 'Secure' : '',
    ]
      .filter(Boolean)
      .join('; ');
  res.setHeader('set-cookie', [
    expire(SESSION_COOKIE, true),
    expire(CSRF_COOKIE, false),
  ]);
}

// ─── Auth middleware ────────────────────────────────────────────────────────

export interface AuthContext {
  authed: boolean;
  reason?: 'no-cookie' | 'bad-cookie' | 'csrf';
}

export function authenticate(req: http.IncomingMessage): AuthContext {
  const cookies = parseCookies(req);
  const tok = cookies[SESSION_COOKIE];
  if (!tok) return { authed: false, reason: 'no-cookie' };
  const session = verify(tok);
  if (!session) return { authed: false, reason: 'bad-cookie' };

  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const csrfHeader = String(req.headers[CSRF_HEADER] || '');
    const csrfCookie = cookies[CSRF_COOKIE] || '';
    if (
      !csrfHeader ||
      csrfHeader !== csrfCookie ||
      csrfHeader !== session.csrf
    ) {
      return { authed: false, reason: 'csrf' };
    }
  }
  return { authed: true };
}
