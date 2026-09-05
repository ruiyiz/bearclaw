import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// auth.ts reads VAR_DIR from config.ts at import time, so the temp home has to
// be exported before anything is imported.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bearclaw-auth-'));
process.env.BEARCLAW_HOME = home;
delete process.env.BEARCLAW_PASSWORD;

const { closeConfigDb, getConfigDb, initConfigDb } =
  await import('../store/config-db.js');
initConfigDb(path.join(home, 'bearclaw.db'));
const { setPassword } = await import('../store/settings.js');
const { authenticate, handleLogin, initAuth, parseCookies } =
  await import('./auth.js');

after(() => {
  closeConfigDb();
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  getConfigDb().exec('DELETE FROM settings');
  delete process.env.BEARCLAW_PASSWORD;
});

function fakeReq(headers: http.IncomingHttpHeaders = {}): http.IncomingMessage {
  return {
    headers,
    method: 'GET',
    socket: { encrypted: false },
  } as unknown as http.IncomingMessage;
}

function fakeRes(): { res: http.ServerResponse; cookies: string[] } {
  const cookies: string[] = [];
  const res = {
    setHeader(_name: string, value: string | string[]) {
      cookies.push(...(Array.isArray(value) ? value : [value]));
    },
  } as unknown as http.ServerResponse;
  return { res, cookies };
}

test('initAuth writes the auth secret under var/', () => {
  initAuth();
  const secret = path.join(home, 'var', 'auth-secret');
  assert.ok(fs.existsSync(secret));
  assert.equal(fs.statSync(secret).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(home, 'var', 'initial-password')));
});

test('login without a password configured asks for setup', () => {
  const { res } = fakeRes();
  assert.deepEqual(handleLogin(fakeReq(), res, { password: 'anything' }), {
    ok: false,
    error: 'setup required',
  });
});

test('login verifies against the stored scrypt hash', () => {
  setPassword('correct horse');
  const bad = fakeRes();
  assert.deepEqual(handleLogin(fakeReq(), bad.res, { password: 'wrong' }), {
    ok: false,
    error: 'bad password',
  });
  assert.equal(bad.cookies.length, 0);

  const good = fakeRes();
  assert.deepEqual(
    handleLogin(fakeReq(), good.res, { password: 'correct horse' }),
    { ok: true },
  );
  assert.equal(good.cookies.length, 2);

  // The issued session cookie authenticates a follow-up request.
  const jar = good.cookies.map((c) => c.split(';')[0]).join('; ');
  assert.equal(authenticate(fakeReq({ cookie: jar })).authed, true);
  assert.ok(parseCookies(fakeReq({ cookie: jar })).nc_session);
});

test('BEARCLAW_PASSWORD overrides the stored hash', () => {
  setPassword('stored-one');
  process.env.BEARCLAW_PASSWORD = 'env-one';
  const a = fakeRes();
  assert.deepEqual(handleLogin(fakeReq(), a.res, { password: 'stored-one' }), {
    ok: false,
    error: 'bad password',
  });
  const b = fakeRes();
  assert.deepEqual(handleLogin(fakeReq(), b.res, { password: 'env-one' }), {
    ok: true,
  });
});
