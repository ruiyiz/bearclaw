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
  agentDir,
  agentVarDir,
} from '../config.js';
import { logger } from '../logger.js';
import { webBroker, type WebOutboundEvent } from './broker.js';
import { authenticate, handleLogin, handleLogout, initAuth } from './auth.js';
import { loadParsedTranscript } from '../agent/runner.js';
import { commands as slashCommands } from '../commands/registry.js';
import {
  archiveWebSession,
  clearWebSessionTitleManualFlag,
  createWebSession,
  deleteWebSession,
  getMessagesByJid,
  getWebSession,
  listWebSessions,
  pinWebSession,
  renameWebSession,
} from '../db.js';
import { generateAndPersistTitle } from '../agent/title-gen.js';
import { randomUUID } from 'node:crypto';
import { transcribeAudio } from '../media/transcribe.js';
import type { WebChannel } from '../channels/web.js';
import {
  addSkillSource,
  agentFolderExists,
  createAgentFolder,
  deleteAgentFolderDir,
  getAllHandlers as adminListHandlers,
  getAllSkillSources,
  getAvailableChannels,
  getAvailableSkillsForSource,
  getHeartbeatLogTail,
  getInstalledSkills,
  getRecentEvents,
  getRecentHandlerLogs,
  createContextFile,
  deleteContextFile,
  installSkill,
  listAgentFolders,
  listContextFiles,
  normalizeChannelJid,
  pauseHandler,
  readContextFile,
  resumeHandler,
  runHealthChecks,
  syncInstalledSkills,
  uninstallSkill,
  writeContextFile,
  deleteHandler as adminDeleteHandler,
  type AgentEntryPatch,
  type ContextScope,
} from '../admin/data.js';
import type { RegisteredAgent } from '../types.js';
import { loadJson, saveJson } from '../utils/json.js';

export interface HttpServerOpts {
  webChannel: WebChannel;
  registeredAgents: () => Record<string, RegisteredAgent>;
  registerWebAgent: (folder: string) => void;
  // Admin-driven mutations. Each callback persists to registered_agents.json
  // and updates the in-memory router map.
  addRegisteredAgent: (jid: string, agent: RegisteredAgent) => void;
  updateRegisteredAgent: (
    jid: string,
    patch: AgentEntryPatch,
  ) => RegisteredAgent | null;
  removeRegisteredAgent: (jid: string) => void;
  removeRegisteredAgentsByFolder: (folder: string) => string[];
  getAgentModel: (folder: string) => string | undefined;
  setAgentModel: (folder: string, model: string) => void;
  getAgentEffort: (folder: string) => string | undefined;
  setAgentEffort: (folder: string, effort: string) => void;
  defaultModel: string;
  defaultEffort: string;
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

const UPLOAD_MAX_BYTES = 60 * 1024 * 1024; // 60 MB after base64-decode

async function readRawBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > maxBytes) {
      return null;
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
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

add('GET', /^\/api\/admin\/agents$/, (_req, res, _url, opts) => {
  const regs = opts.registeredAgents();
  const agents = Object.entries(regs).map(([jid, a]) => ({ ...a, jid }));
  json(res, 200, { agents });
});

add('GET', /^\/api\/admin\/agents\/channels$/, (_req, res) => {
  json(res, 200, { channels: getAvailableChannels() });
});

add('GET', /^\/api\/admin\/agents\/folders$/, (_req, res) => {
  json(res, 200, { folders: listAgentFolders() });
});

interface CreateAgentBody {
  folder?: string;
  name?: string;
  templateFolder?: string;
}

add('POST', /^\/api\/admin\/agents$/, async (req, res, _url, opts) => {
  const body = (await readBody(req)) as CreateAgentBody;
  const folder = (body.folder || '').trim();
  const name = (body.name || '').trim() || folder;
  if (!folder) return json(res, 400, { error: 'missing folder' });
  if (agentFolderExists(folder)) {
    return json(res, 409, { error: 'folder already exists' });
  }
  try {
    createAgentFolder({
      folder,
      displayName: name,
      templateFolder: body.templateFolder,
    });
  } catch (err) {
    return json(res, 400, { error: String(err) });
  }
  // Every new agent gets a web channel so it's immediately reachable in the
  // web UI. Other channels are wired afterward via "+ Channel". Web threads
  // route by folder, never by trigger — keep the trigger empty here.
  const wiredJid = `web:${folder}`;
  opts.addRegisteredAgent(wiredJid, {
    name,
    folder,
    trigger: '',
    added_at: new Date().toISOString(),
  });
  json(res, 201, { ok: true, folder, wiredJid });
});

interface WireAgentBody {
  folder?: string;
  jid?: string;
  name?: string;
  trigger?: string;
  primary?: boolean;
}

add('POST', /^\/api\/admin\/agents\/wire$/, async (req, res, _url, opts) => {
  const body = (await readBody(req)) as WireAgentBody;
  const folder = (body.folder || '').trim();
  const jid = normalizeChannelJid(body.jid || '');
  if (!folder || !jid) {
    return json(res, 400, { error: 'missing folder or invalid jid' });
  }
  if (!agentFolderExists(folder)) {
    return json(res, 400, { error: 'unknown agent folder' });
  }
  const existing = opts.registeredAgents()[jid];
  if (existing) {
    return json(res, 409, { error: `jid already wired to ${existing.folder}` });
  }
  const sibling = Object.values(opts.registeredAgents()).find(
    (a) => a.folder === folder,
  );
  const name = (body.name || '').trim() || sibling?.name || folder;
  // Web threads route by folder, never by trigger — force it empty regardless
  // of what the caller sent.
  const trigger = jid.startsWith('web:')
    ? ''
    : typeof body.trigger === 'string'
      ? body.trigger
      : (sibling?.trigger ?? '');
  const agent: RegisteredAgent = {
    name,
    folder,
    trigger,
    added_at: new Date().toISOString(),
    ...(body.primary ? { primary: true } : {}),
  };
  opts.addRegisteredAgent(jid, agent);
  json(res, 201, { ok: true, jid, agent });
});

add('PATCH', /^\/api\/admin\/agents\/by-jid$/, async (req, res, _url, opts) => {
  const body = (await readBody(req)) as {
    jid?: string;
    name?: string;
    trigger?: string;
    primary?: boolean;
  };
  const jid = (body.jid || '').trim();
  if (!jid) return json(res, 400, { error: 'missing jid' });
  if (!opts.registeredAgents()[jid]) {
    return json(res, 404, { error: 'unknown jid' });
  }
  const next = opts.updateRegisteredAgent(jid, {
    name: body.name,
    trigger: body.trigger,
    primary: body.primary,
  });
  if (!next) return json(res, 404, { error: 'unknown jid' });
  json(res, 200, { ok: true, jid, agent: next });
});

add('DELETE', /^\/api\/admin\/agents\/by-jid$/, async (req, res, url, opts) => {
  const jid = (url.searchParams.get('jid') || '').trim();
  if (!jid) return json(res, 400, { error: 'missing jid' });
  if (!opts.registeredAgents()[jid]) {
    return json(res, 404, { error: 'unknown jid' });
  }
  opts.removeRegisteredAgent(jid);
  json(res, 200, { ok: true });
});

add(
  'DELETE',
  /^\/api\/admin\/agents\/by-folder$/,
  async (req, res, url, opts) => {
    const folder = (url.searchParams.get('folder') || '').trim();
    const deleteFiles = url.searchParams.get('deleteFiles') === '1';
    const deleteVar = url.searchParams.get('deleteVar') === '1';
    if (!folder) return json(res, 400, { error: 'missing folder' });
    if (folder === MAIN_AGENT_FOLDER) {
      return json(res, 400, { error: 'cannot delete main agent' });
    }
    const removed = opts.removeRegisteredAgentsByFolder(folder);
    let filesDeleted = false;
    if (deleteFiles) {
      try {
        deleteAgentFolderDir(folder, { includeVar: deleteVar });
        filesDeleted = true;
      } catch (err) {
        return json(res, 200, {
          ok: true,
          unwired: removed,
          filesDeleted: false,
          fileError: String(err),
        });
      }
    }
    json(res, 200, {
      ok: true,
      unwired: removed,
      filesDeleted,
      folderPath: agentDir(folder),
    });
  },
);

add('GET', /^\/api\/admin\/health$/, (_req, res) => {
  json(res, 200, { checks: runHealthChecks() });
});

add('GET', /^\/api\/admin\/heartbeat$/, (_req, res, url) => {
  const folder = url.searchParams.get('folder') || MAIN_AGENT_FOLDER;
  const lines = parseInt(url.searchParams.get('lines') || '40', 10);
  json(res, 200, { folder, log: getHeartbeatLogTail(folder, lines) });
});

add('GET', /^\/api\/admin\/context$/, (_req, res) => {
  json(res, 200, listContextFiles());
});

function parseContextQuery(url: URL): {
  scope: ContextScope;
  folder: string | null;
  name: string;
} | null {
  const scope = url.searchParams.get('scope');
  const name = url.searchParams.get('name') || '';
  const folder = url.searchParams.get('folder');
  if (scope !== 'shared' && scope !== 'agent') return null;
  if (!name) return null;
  return { scope, folder: scope === 'agent' ? folder : null, name };
}

add('GET', /^\/api\/admin\/context\/file$/, (_req, res, url) => {
  const q = parseContextQuery(url);
  if (!q) return json(res, 400, { error: 'missing fields' });
  try {
    json(res, 200, {
      scope: q.scope,
      folder: q.folder,
      name: q.name,
      ...readContextFile(q.scope, q.folder, q.name),
    });
  } catch (err) {
    json(res, 400, { error: String(err) });
  }
});

add('POST', /^\/api\/admin\/context\/file$/, async (req, res, url) => {
  const q = parseContextQuery(url);
  if (!q) return json(res, 400, { error: 'missing fields' });
  const body = (await readBody(req)) as { content?: string };
  const content = typeof body.content === 'string' ? body.content : '';
  try {
    const meta = createContextFile(q.scope, q.folder, q.name, content);
    json(res, 201, { ok: true, ...meta });
  } catch (err) {
    json(res, 400, { error: String(err) });
  }
});

add('DELETE', /^\/api\/admin\/context\/file$/, (_req, res, url) => {
  const q = parseContextQuery(url);
  if (!q) return json(res, 400, { error: 'missing fields' });
  try {
    deleteContextFile(q.scope, q.folder, q.name);
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 400, { error: String(err) });
  }
});

add('PUT', /^\/api\/admin\/context\/file$/, async (req, res, url) => {
  const q = parseContextQuery(url);
  if (!q) return json(res, 400, { error: 'missing fields' });
  const body = (await readBody(req)) as { content?: string };
  if (typeof body.content !== 'string')
    return json(res, 400, { error: 'missing content' });
  try {
    const meta = writeContextFile(q.scope, q.folder, q.name, body.content);
    json(res, 200, { ok: true, ...meta });
  } catch (err) {
    json(res, 400, { error: String(err) });
  }
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
      model: opts.getAgentModel(a.folder) || opts.defaultModel,
      effort: opts.getAgentEffort(a.folder) || opts.defaultEffort,
    })),
    main: MAIN_AGENT_FOLDER,
    defaults: { model: opts.defaultModel, effort: opts.defaultEffort },
  });
});

add('PATCH', /^\/api\/user\/agents\/([^/]+)$/, async (req, res, _url, opts) => {
  const m = _url.pathname.match(/^\/api\/user\/agents\/([^/]+)$/);
  const folder = m ? decodeURIComponent(m[1]) : '';
  if (!folder) return json(res, 400, { error: 'missing folder' });
  const body = (await readBody(req)) as { model?: string; effort?: string };
  if (typeof body.model === 'string' && body.model.length > 0) {
    opts.setAgentModel(folder, body.model);
  }
  if (typeof body.effort === 'string' && body.effort.length > 0) {
    opts.setAgentEffort(folder, body.effort);
  }
  json(res, 200, {
    ok: true,
    model: opts.getAgentModel(folder) || opts.defaultModel,
    effort: opts.getAgentEffort(folder) || opts.defaultEffort,
  });
});

add('POST', /^\/api\/user\/chat$/, async (req, res, _url, opts) => {
  const body = (await readBody(req)) as {
    folder?: string;
    sessionId?: string;
    text?: string;
    senderName?: string;
  };
  if (!body.folder || !body.text)
    return json(res, 400, { error: 'missing fields' });
  const sessionId = body.sessionId || 'legacy';
  ensureWebSession(body.folder, sessionId);
  const jid = `web:${body.folder}:${sessionId}`;
  opts.registerWebAgent(body.folder);
  opts.webChannel.ingest(jid, body.text, body.senderName || 'You');
  json(res, 202, { ok: true, jid, sessionId });
});

function ensureWebSession(folder: string, sessionId: string): void {
  if (getWebSession(folder, sessionId)) return;
  createWebSession({
    id: sessionId,
    folder,
    title: sessionId === 'legacy' ? 'Imported history' : null,
    created_at: new Date().toISOString(),
  });
}

type UploadKind = 'image' | 'video' | 'audio' | 'document' | 'voice';

function safeExtFromName(name: string, mime: string): string {
  const fromName = path.extname(name).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  if (mime.includes('png')) return '.png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('mpeg')) return '.mp3';
  if (mime.includes('pdf')) return '.pdf';
  return '.bin';
}

add('POST', /^\/api\/user\/chat\/upload$/, async (req, res, _url, opts) => {
  const raw = await readRawBody(req, UPLOAD_MAX_BYTES + 1024 * 1024);
  if (!raw) return json(res, 413, { error: 'payload too large' });
  let body: {
    folder?: string;
    sessionId?: string;
    kind?: UploadKind;
    fileName?: string;
    mimeType?: string;
    dataB64?: string;
    caption?: string;
    senderName?: string;
  };
  try {
    body = JSON.parse(raw.toString('utf-8'));
  } catch {
    return json(res, 400, { error: 'invalid json' });
  }
  const { folder, kind, fileName, mimeType, dataB64, caption, senderName } =
    body;
  if (!folder || !kind || !dataB64)
    return json(res, 400, { error: 'missing fields' });
  if (!['image', 'video', 'audio', 'document', 'voice'].includes(kind))
    return json(res, 400, { error: 'invalid kind' });

  let buffer: Buffer;
  try {
    buffer = Buffer.from(dataB64, 'base64');
  } catch {
    return json(res, 400, { error: 'invalid base64' });
  }
  if (buffer.length === 0) return json(res, 400, { error: 'empty file' });
  if (buffer.length > UPLOAD_MAX_BYTES)
    return json(res, 413, { error: 'file too large' });

  const sessionId = body.sessionId || 'legacy';
  ensureWebSession(folder, sessionId);
  const jid = `web:${folder}:${sessionId}`;
  opts.registerWebAgent(folder);

  // Voice: transcribe + ingest text only. Mirrors Telegram voice flow.
  if (kind === 'voice') {
    let transcript: string | null = null;
    try {
      transcript = await transcribeAudio(buffer, `web-voice-${Date.now()}`);
    } catch (err) {
      logger.warn({ err }, 'Web voice transcription failed');
    }
    const text = transcript
      ? `[Voice message] ${transcript}`
      : '[Voice message - transcription failed]';
    opts.webChannel.ingest(jid, text, senderName || 'You');
    return json(res, 202, { ok: true, kind, transcript });
  }

  // Persist file to per-agent media dir.
  const ext = safeExtFromName(fileName || '', mimeType || '');
  const mediaDir = path.join(agentVarDir(folder), 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const base = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const filePath = path.join(mediaDir, base);
  fs.writeFileSync(filePath, buffer);

  const captionPart = caption ? ` ${caption}` : '';
  const tagByKind: Record<Exclude<UploadKind, 'voice'>, string> = {
    image: 'Photo',
    video: 'Video',
    audio: 'Audio',
    document: 'Document',
  };
  const tag = tagByKind[kind as Exclude<UploadKind, 'voice'>];
  const text = `[${tag}: ${filePath}]${captionPart}`;
  opts.webChannel.ingest(jid, text, senderName || 'You');
  json(res, 202, { ok: true, kind, path: filePath });
});

add('GET', /^\/api\/user\/chat\/stream$/, (_req, res, url) => {
  const folder = url.searchParams.get('folder');
  const sessionId = url.searchParams.get('sessionId') || 'legacy';
  const jid = folder ? `web:${folder}:${sessionId}` : null;
  // Disable Nagle so small SSE chunks ship the moment they're written instead
  // of being coalesced for ~40ms / next ACK by the kernel.
  if (res.socket && typeof res.socket.setNoDelay === 'function') {
    res.socket.setNoDelay(true);
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  const channel = jid ? `out:${jid}` : 'out:*';

  const handler = (evt: WebOutboundEvent) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };
  webBroker.on(channel, handler);

  const ka = setInterval(() => res.write(': ka\n\n'), 25000);

  const cleanup = () => {
    clearInterval(ka);
    webBroker.off(channel, handler);
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
});

add('GET', /^\/api\/user\/chat\/messages$/, (_req, res, url) => {
  const folder = url.searchParams.get('folder');
  if (!folder) return json(res, 400, { error: 'missing folder' });
  const sessionId = url.searchParams.get('sessionId') || 'legacy';
  const before = url.searchParams.get('before');
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get('limit') || '200', 10), 1),
    1000,
  );
  const jid = `web:${folder}:${sessionId}`;
  const rows = getMessagesByJid(jid, before, limit);
  // Returned in DB order (newest first); client reverses for render.
  json(res, 200, {
    messages: rows.map((m) => ({
      id: m.id,
      chatJid: m.chat_jid,
      sender: m.sender,
      senderName: m.sender_name,
      content: m.content,
      timestamp: m.timestamp,
      isFromMe: m.is_from_me === 1,
    })),
  });
});

// ─── Web session CRUD ─────────────────────────────────────────────────────

add('GET', /^\/api\/user\/chat\/sessions$/, (_req, res, url) => {
  const folder = url.searchParams.get('folder');
  if (!folder) return json(res, 400, { error: 'missing folder' });
  const includeArchived = url.searchParams.get('includeArchived') === '1';
  const rows = listWebSessions(folder, includeArchived);
  json(res, 200, {
    sessions: rows.map((s) => ({
      id: s.id,
      folder: s.folder,
      title: s.title,
      sdkSessionId: s.sdk_session_id,
      createdAt: s.created_at,
      lastMessageAt: s.last_message_at,
      pinned: s.pinned === 1,
      archived: s.archived === 1,
    })),
  });
});

add('POST', /^\/api\/user\/chat\/sessions$/, async (req, res) => {
  const body = (await readBody(req)) as { folder?: string; title?: string };
  if (!body.folder) return json(res, 400, { error: 'missing folder' });
  const id = randomUUID();
  const created_at = new Date().toISOString();
  createWebSession({
    id,
    folder: body.folder,
    title: body.title ?? null,
    created_at,
  });
  json(res, 201, {
    id,
    chatJid: `web:${body.folder}:${id}`,
    folder: body.folder,
    title: body.title ?? null,
    createdAt: created_at,
  });
});

add(
  'PATCH',
  /^\/api\/user\/chat\/sessions\/([^/]+)$/,
  async (req, res, url) => {
    const id = decodeURIComponent(url.pathname.split('/').pop()!);
    const body = (await readBody(req)) as {
      folder?: string;
      title?: string;
      pinned?: boolean;
      archived?: boolean;
    };
    if (!body.folder) return json(res, 400, { error: 'missing folder' });
    const existing = getWebSession(body.folder, id);
    if (!existing) return json(res, 404, { error: 'not found' });
    if (typeof body.title === 'string') {
      renameWebSession(body.folder, id, body.title);
    }
    if (typeof body.pinned === 'boolean') {
      pinWebSession(body.folder, id, body.pinned);
    }
    if (typeof body.archived === 'boolean') {
      archiveWebSession(body.folder, id, body.archived);
    }
    json(res, 200, { ok: true });
  },
);

add(
  'POST',
  /^\/api\/user\/chat\/sessions\/([^/]+)\/regenerate-title$/,
  async (req, res, url) => {
    const id = decodeURIComponent(url.pathname.split('/').slice(-2, -1)[0]);
    const body = (await readBody(req)) as { folder?: string };
    if (!body.folder) return json(res, 400, { error: 'missing folder' });
    const existing = getWebSession(body.folder, id);
    if (!existing) return json(res, 404, { error: 'not found' });
    clearWebSessionTitleManualFlag(body.folder, id);
    try {
      await generateAndPersistTitle(body.folder, id);
    } catch (err) {
      logger.warn({ err, folder: body.folder, id }, 'Regenerate-title failed');
      return json(res, 500, { error: 'title-gen failed' });
    }
    const updated = getWebSession(body.folder, id);
    json(res, 200, { ok: true, title: updated?.title ?? null });
  },
);

add(
  'DELETE',
  /^\/api\/user\/chat\/sessions\/([^/]+)$/,
  async (_req, res, url) => {
    const id = decodeURIComponent(url.pathname.split('/').pop()!);
    const folder = url.searchParams.get('folder');
    const hard = url.searchParams.get('hard') === '1';
    if (!folder) return json(res, 400, { error: 'missing folder' });
    const existing = getWebSession(folder, id);
    if (!existing) return json(res, 404, { error: 'not found' });
    if (hard) {
      deleteWebSession(folder, id);
    } else {
      archiveWebSession(folder, id, true);
    }
    json(res, 200, { ok: true });
  },
);

// Read-only JSONL transcript inspection lives under /admin so the user-facing
// chat surface stays focused on the live conversation. Same handlers, admin
// route prefix.
add('GET', /^\/api\/admin\/transcripts\/sessions$/, async (_req, res, url) => {
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

add('GET', /^\/api\/admin\/transcripts\/messages$/, async (_req, res, url) => {
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

add('GET', /^\/api\/user\/commands$/, (_req, res) => {
  json(res, 200, {
    commands: slashCommands.map((c) => ({
      name: c.name,
      description: c.description,
    })),
  });
});

// ─── Agent-media passthrough (per-agent persisted files) ───────────────────

function mediaContentType(file: string): string {
  return guessContentType(file);
}

add('GET', /^\/api\/user\/agent-media$/, (_req, res, url) => {
  const folder = url.searchParams.get('folder');
  const rel = url.searchParams.get('path');
  if (!folder || !rel) {
    res.writeHead(400);
    res.end('missing params');
    return;
  }
  const baseDir = path.resolve(agentVarDir(folder), 'media');
  // Accept absolute paths that resolve into baseDir, or names relative to it.
  const candidate = path.isAbsolute(rel)
    ? path.resolve(rel)
    : path.resolve(baseDir, rel);
  if (candidate !== baseDir && !candidate.startsWith(baseDir + path.sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': mediaContentType(candidate),
    'cache-control': 'private, max-age=3600',
  });
  fs.createReadStream(candidate).pipe(res);
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
      // Inherit name from any existing registration for this folder. Web
      // threads route by folder, never by trigger — leave it empty.
      const sibling = Object.values(all).find((a) => a.folder === folder);
      const agent: RegisteredAgent = {
        name: sibling?.name || folder,
        folder,
        trigger: '',
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
