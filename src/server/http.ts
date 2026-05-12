import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

import { listSessions } from '@anthropic-ai/claude-agent-sdk';

import {
  CACHE_DIR,
  CONFIG_DIR,
  DATA_DIR,
  MAIN_AGENT_FOLDER,
  agentVarDir,
} from '../config.js';
import { logger } from '../logger.js';
import { webBroker, type WebOutboundEvent } from './broker.js';
import { authenticate, handleLogin, handleLogout, initAuth } from './auth.js';
import { loadParsedTranscript } from '../agent/runner.js';
import type { WebChannel } from '../channels/web.js';
import {
  addSkillSource,
  getAllHandlers as adminListHandlers,
  getAllSkillSources,
  getAvailableSkillsForSource,
  getHeartbeatLogTail,
  getInstalledSkills,
  getRecentEvents,
  getRecentHandlerLogs,
  getRegisteredAgents,
  installSkill,
  pauseHandler,
  resumeHandler,
  runHealthChecks,
  syncInstalledSkills,
  uninstallSkill,
  deleteHandler as adminDeleteHandler,
} from '../admin/data.js';
import type { RegisteredAgent } from '../types.js';
import { loadJson, saveJson } from '../utils/json.js';

export interface HttpServerOpts {
  webChannel: WebChannel;
  registeredAgents: () => Record<string, RegisteredAgent>;
  registerWebAgent: (folder: string) => void;
}

const DEFAULT_PORT = parseInt(process.env.NANOCLAW_HTTP_PORT || '7878', 10);
const HOST = process.env.NANOCLAW_HTTP_HOST || '127.0.0.1';

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  opts: HttpServerOpts,
) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const routes: Route[] = [];

function add(method: string, pattern: RegExp, handler: Handler): void {
  routes.push({ method, pattern, handler });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ─── Auth routes (public) ──────────────────────────────────────────────────

add('POST', /^\/api\/auth\/login$/, async (req, res) => {
  const body = (await readBody(req)) as { password?: string };
  const result = handleLogin(req, res, body);
  if (!result.ok) return json(res, 401, { ok: false, error: result.error });
  json(res, 200, { ok: true });
});

add('POST', /^\/api\/auth\/logout$/, async (_req, res) => {
  handleLogout(_req, res);
  json(res, 200, { ok: true });
});

add('GET', /^\/api\/auth\/me$/, (req, res) => {
  const ctx = authenticate(req);
  // /me always returns 200; only `authed` flag tells the client.
  json(res, 200, { authed: ctx.authed });
});

// ─── Admin routes ───────────────────────────────────────────────────────────

add('GET', /^\/api\/admin\/skills$/, (_req, res) => {
  json(res, 200, { skills: getInstalledSkills() });
});

add('GET', /^\/api\/admin\/skills\/sources$/, (_req, res) => {
  json(res, 200, { sources: getAllSkillSources() });
});

add('GET', /^\/api\/admin\/skills\/available$/, (_req, res, url) => {
  const source = url.searchParams.get('source') || '';
  json(res, 200, { skills: getAvailableSkillsForSource(source) });
});

add('POST', /^\/api\/admin\/skills\/install$/, async (req, res) => {
  const body = (await readBody(req)) as { sourcePath?: string; name?: string };
  if (!body.sourcePath || !body.name)
    return json(res, 400, { error: 'missing fields' });
  installSkill(body.sourcePath, body.name);
  json(res, 200, { ok: true });
});

add('POST', /^\/api\/admin\/skills\/uninstall$/, async (req, res) => {
  const body = (await readBody(req)) as { name?: string };
  if (!body.name) return json(res, 400, { error: 'missing name' });
  uninstallSkill(body.name);
  json(res, 200, { ok: true });
});

add('POST', /^\/api\/admin\/skills\/sync$/, async (_req, res) => {
  json(res, 200, syncInstalledSkills());
});

add('POST', /^\/api\/admin\/skills\/sources$/, async (req, res) => {
  const body = (await readBody(req)) as { dir?: string };
  if (!body.dir) return json(res, 400, { error: 'missing dir' });
  addSkillSource(body.dir);
  json(res, 200, { ok: true });
});

add('GET', /^\/api\/admin\/events$/, (_req, res, url) => {
  const limit = parseInt(url.searchParams.get('limit') || '200', 10);
  json(res, 200, { events: getRecentEvents(limit) });
});

add('GET', /^\/api\/admin\/handlers$/, (_req, res) => {
  json(res, 200, { handlers: adminListHandlers() });
});

add('GET', /^\/api\/admin\/handler-logs$/, (_req, res, url) => {
  const limit = parseInt(url.searchParams.get('limit') || '100', 10);
  json(res, 200, { logs: getRecentHandlerLogs(limit) });
});

add(
  'POST',
  /^\/api\/admin\/handlers\/([^/]+)\/pause$/,
  async (_req, res, url) => {
    const id = decodeURIComponent(url.pathname.split('/')[4]);
    pauseHandler(id);
    json(res, 200, { ok: true });
  },
);

add(
  'POST',
  /^\/api\/admin\/handlers\/([^/]+)\/resume$/,
  async (_req, res, url) => {
    const id = decodeURIComponent(url.pathname.split('/')[4]);
    resumeHandler(id);
    json(res, 200, { ok: true });
  },
);

add('DELETE', /^\/api\/admin\/handlers\/([^/]+)$/, async (_req, res, url) => {
  const id = decodeURIComponent(url.pathname.split('/')[4]);
  adminDeleteHandler(id);
  json(res, 200, { ok: true });
});

add('GET', /^\/api\/admin\/agents$/, (_req, res) => {
  json(res, 200, { agents: getRegisteredAgents() });
});

add('GET', /^\/api\/admin\/health$/, (_req, res) => {
  json(res, 200, { checks: runHealthChecks() });
});

add('GET', /^\/api\/admin\/heartbeat$/, (_req, res, url) => {
  const folder = url.searchParams.get('folder') || MAIN_AGENT_FOLDER;
  const lines = parseInt(url.searchParams.get('lines') || '40', 10);
  json(res, 200, { folder, log: getHeartbeatLogTail(folder, lines) });
});

add('GET', /^\/api\/admin\/config$/, (_req, res) => {
  json(res, 200, {
    home: process.env.HOME,
    configDir: CONFIG_DIR,
    dataDir: DATA_DIR,
    cacheDir: CACHE_DIR,
    env: {
      ASSISTANT_NAME: process.env.ASSISTANT_NAME ?? 'Andy',
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ? 'set' : 'unset',
      TELEGRAM_ONLY: process.env.TELEGRAM_ONLY === 'true',
      IMESSAGE_ENABLED: process.env.IMESSAGE_ENABLED === 'true',
    },
  });
});

// ─── User routes ────────────────────────────────────────────────────────────

add('GET', /^\/api\/user\/agents$/, (_req, res, _url, opts) => {
  const regs = opts.registeredAgents();
  // Surface unique agent folders that are reachable via the web channel
  // (registered as web:<folder> below) plus any other folder so the user
  // can pick a target and have it auto-registered.
  const byFolder = new Map<string, RegisteredAgent & { jid: string }>();
  for (const [jid, agent] of Object.entries(regs)) {
    if (!byFolder.has(agent.folder))
      byFolder.set(agent.folder, { ...agent, jid });
  }
  json(res, 200, {
    agents: [...byFolder.values()].map((a) => ({
      folder: a.folder,
      name: a.name,
      trigger: a.trigger,
      webJid: `web:${a.folder}`,
    })),
    main: MAIN_AGENT_FOLDER,
  });
});

add('POST', /^\/api\/user\/chat$/, async (req, res, _url, opts) => {
  const body = (await readBody(req)) as {
    folder?: string;
    text?: string;
    senderName?: string;
  };
  if (!body.folder || !body.text)
    return json(res, 400, { error: 'missing fields' });
  const jid = `web:${body.folder}`;
  opts.registerWebAgent(body.folder);
  opts.webChannel.ingest(jid, body.text, body.senderName || 'You');
  json(res, 202, { ok: true, jid });
});

add('GET', /^\/api\/user\/chat\/stream$/, (_req, res, url) => {
  const folder = url.searchParams.get('folder');
  const jid = folder ? `web:${folder}` : null;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  const handler = (evt: WebOutboundEvent) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };
  const channel = jid ? `out:${jid}` : 'out:*';
  webBroker.on(channel, handler);

  const ka = setInterval(() => res.write(': ka\n\n'), 25000);

  const cleanup = () => {
    clearInterval(ka);
    webBroker.off(channel, handler);
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
});

add('GET', /^\/api\/user\/chat\/sessions$/, async (_req, res, url) => {
  const folder = url.searchParams.get('folder');
  if (!folder) return json(res, 400, { error: 'missing folder' });
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  try {
    const sessions = await listSessions({
      dir: agentVarDir(folder),
      includeWorktrees: false,
      limit,
    });
    json(res, 200, {
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        summary: s.summary,
        firstPrompt: s.firstPrompt,
        lastModified: s.lastModified,
        createdAt: s.createdAt,
      })),
    });
  } catch (err) {
    logger.error({ err, folder }, 'listSessions failed');
    json(res, 500, { error: String(err) });
  }
});

add('GET', /^\/api\/user\/chat\/history$/, async (_req, res, url) => {
  const folder = url.searchParams.get('folder');
  const sessionId = url.searchParams.get('sessionId');
  if (!folder || !sessionId)
    return json(res, 400, { error: 'missing folder or sessionId' });
  if (!/^[0-9a-f-]{36}$/i.test(sessionId))
    return json(res, 400, { error: 'invalid sessionId' });
  try {
    const messages = await loadParsedTranscript(sessionId, agentVarDir(folder));
    json(res, 200, { messages });
  } catch (err) {
    logger.error({ err, folder, sessionId }, 'loadParsedTranscript failed');
    json(res, 500, { error: String(err) });
  }
});

add('GET', /^\/api\/user\/events$/, (_req, res, url) => {
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  json(res, 200, { events: getRecentEvents(limit) });
});

// ─── Media passthrough ──────────────────────────────────────────────────────

add('GET', /^\/api\/media\/([^/]+)$/, (_req, res, url) => {
  const file = decodeURIComponent(url.pathname.split('/').pop() || '');
  if (file.includes('..') || file.includes('/')) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }
  const full = path.join(CACHE_DIR, 'web-media', file);
  if (!fs.existsSync(full)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': guessContentType(file),
    'cache-control': 'public, max-age=31536000, immutable',
  });
  fs.createReadStream(full).pipe(res);
});

function guessContentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.mp4':
      return 'video/mp4';
    case '.ogg':
      return 'audio/ogg';
    case '.pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

// ─── Registered-agent helper persisted to disk ──────────────────────────────

export function persistRegisteredAgentsHelper(): {
  ensureWebAgent: (folder: string) => RegisteredAgent;
} {
  const registeredPath = path.join(CONFIG_DIR, 'registered_agents.json');
  return {
    ensureWebAgent(folder: string): RegisteredAgent {
      const all = loadJson<Record<string, RegisteredAgent>>(registeredPath, {});
      const jid = `web:${folder}`;
      if (all[jid]) return all[jid];
      // Inherit trigger/name from any existing registration for this folder.
      const sibling = Object.values(all).find((a) => a.folder === folder);
      const agent: RegisteredAgent = {
        name: sibling?.name || folder,
        folder,
        trigger:
          sibling?.trigger || (folder === MAIN_AGENT_FOLDER ? '' : folder),
        added_at: new Date().toISOString(),
      };
      all[jid] = agent;
      saveJson(registeredPath, all);
      return agent;
    },
  };
}

// ─── Server bootstrap ───────────────────────────────────────────────────────

// Routes that bypass the cookie-auth gate. Everything else under /api/* must
// present a valid session cookie. Non-/api/* paths (none today) bypass too.
const PUBLIC_API: Array<RegExp> = [
  /^\/api\/auth\/login$/,
  /^\/api\/auth\/me$/,
  /^\/api\/auth\/logout$/,
  // Media URLs are issued to authed clients; keep gated. If we ever need an
  // unauthenticated thumb/share endpoint, add a separate path here.
];

function isPublic(pathname: string): boolean {
  return PUBLIC_API.some((re) => re.test(pathname));
}

export function startHttpServer(opts: HttpServerOpts): http.Server {
  initAuth();
  const server = http.createServer(async (req, res) => {
    // Same-origin only. Web app is proxied through Next, so requests share
    // the origin. Refuse cross-origin to keep CSRF surface minimal.
    res.setHeader('vary', 'origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url || '/', `http://${HOST}`);
    } catch {
      res.writeHead(400);
      res.end('bad url');
      return;
    }

    // Auth gate for /api/*.
    if (url.pathname.startsWith('/api/') && !isPublic(url.pathname)) {
      const ctx = authenticate(req);
      if (!ctx.authed) {
        json(res, 401, { error: 'unauthorized', reason: ctx.reason });
        return;
      }
    }

    for (const route of routes) {
      if (route.method !== req.method) continue;
      if (!route.pattern.test(url.pathname)) continue;
      try {
        await route.handler(req, res, url, opts);
      } catch (err) {
        logger.error({ err, url: url.pathname }, 'HTTP route error');
        if (!res.headersSent) json(res, 500, { error: String(err) });
        else res.end();
      }
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  server.listen(DEFAULT_PORT, HOST, () => {
    logger.info({ host: HOST, port: DEFAULT_PORT }, 'HTTP server listening');
  });

  return server;
}
