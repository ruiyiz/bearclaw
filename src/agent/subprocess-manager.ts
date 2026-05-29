import fs from 'fs';
import path from 'path';
import os from 'os';
import * as pty from 'node-pty';
import { CACHE_DIR, RUN_DIR } from '../config.js';
import { createHandler, emitEvent } from '../db.js';
import { logger } from '../logger.js';

const SUBPROCESSES_DIR = path.join(RUN_DIR, 'subprocesses');
const BIN_DIR = path.join(CACHE_DIR, 'bin');
const NOTIFY_SCRIPT_PATH = path.join(BIN_DIR, 'bearclaw-notify');

interface SessionState {
  sessionId: string;
  name?: string;
  description?: string;
  command: string;
  workdir?: string;
  agentFolder: string;
  chatJid: string;
  pid: number;
  status: 'running' | 'exited';
  exitCode?: number;
  signal?: number;
  startedAt: string;
  exitedAt?: string;
}

interface LiveSession {
  ptyProcess: pty.IPty;
  state: SessionState;
}

const liveSessions = new Map<string, LiveSession>();

const NOTIFY_SCRIPT_CONTENT = `#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';

const [,, sessionId, eventType] = process.argv;
if (!sessionId || !eventType) process.exit(1);

const home = path.join(os.homedir(), '.bearclaw');
const sessionFile = path.join(home, 'var', 'run', 'subprocesses', sessionId + '.json');

let session;
try {
  session = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
} catch {
  process.exit(1);
}

let stdinData = {};
try {
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding('utf-8');
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    if (raw.trim()) stdinData = JSON.parse(raw);
  }
} catch {}

const ipcType = 'subprocess_notification';
const tasksDir = path.join(home, 'var', 'run', 'ipc', session.agentFolder, 'tasks');
fs.mkdirSync(tasksDir, { recursive: true });

const filename = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.json';
const filepath = path.join(tasksDir, filename);
const tempPath = filepath + '.tmp';

const data = {
  type: 'emit_event',
  eventType: ipcType,
  payload: { sessionId, ...stdinData },
  agentFolder: session.agentFolder,
  timestamp: new Date().toISOString()
};

fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
fs.renameSync(tempPath, filepath);
`;

function saveSessionState(state: SessionState): void {
  const stateFile = path.join(SUBPROCESSES_DIR, `${state.sessionId}.json`);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function loadSessionState(sessionId: string): SessionState | null {
  const stateFile = path.join(SUBPROCESSES_DIR, `${sessionId}.json`);
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as SessionState;
  } catch {
    return null;
  }
}

function recoverSessions(): void {
  let files: string[];
  try {
    files = fs.readdirSync(SUBPROCESSES_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const file of files) {
    const sessionId = file.replace('.json', '');
    const state = loadSessionState(sessionId);
    if (!state || state.status === 'exited') continue;

    let alive = false;
    try {
      process.kill(state.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }

    if (!alive) {
      state.status = 'exited';
      state.exitedAt = new Date().toISOString();
      saveSessionState(state);
      logger.info(
        { sessionId, pid: state.pid },
        'Subprocess recovered as exited',
      );
    }
  }
}

export function initSubprocessManager(): void {
  fs.mkdirSync(SUBPROCESSES_DIR, { recursive: true });
  fs.mkdirSync(BIN_DIR, { recursive: true });

  fs.writeFileSync(NOTIFY_SCRIPT_PATH, NOTIFY_SCRIPT_CONTENT);
  fs.chmodSync(NOTIFY_SCRIPT_PATH, 0o755);

  recoverSessions();
  logger.info('Subprocess manager initialized');
}

export function startSubprocess(params: {
  name?: string;
  description?: string;
  command: string;
  workdir?: string;
  agentFolder: string;
  chatJid: string;
  cols?: number;
  rows?: number;
  on_exit?: string;
  on_notification?: string;
  prompt_suffix?: string;
  pre_spawn?: (sessionId: string) => void;
}): string {
  const {
    agentFolder,
    chatJid,
    cols = 220,
    rows = 50,
    on_exit,
    on_notification,
  } = params;
  const sessionId = `proc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const workdir = params.workdir
    ? path.resolve(params.workdir.replace(/^~/, os.homedir()))
    : undefined;

  params.pre_spawn?.(sessionId);

  let command = params.command;
  if (params.prompt_suffix) {
    command =
      command + params.prompt_suffix.replace(/\{sessionId\}/g, sessionId);
  }

  const ptyProcess = pty.spawn('sh', ['-c', command], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: workdir || os.homedir(),
    env: process.env as Record<string, string>,
  });

  const state: SessionState = {
    sessionId,
    name: params.name,
    description: params.description,
    command: params.command,
    workdir,
    agentFolder,
    chatJid,
    pid: ptyProcess.pid,
    status: 'running',
    startedAt: new Date().toISOString(),
  };
  saveSessionState(state);

  const outputFile = path.join(SUBPROCESSES_DIR, `${sessionId}.output`);

  ptyProcess.onData((data) => {
    fs.appendFileSync(outputFile, data);
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    const live = liveSessions.get(sessionId);
    if (live) {
      live.state.status = 'exited';
      live.state.exitCode = exitCode;
      live.state.signal = signal ?? undefined;
      live.state.exitedAt = new Date().toISOString();
      saveSessionState(live.state);
      liveSessions.delete(sessionId);
    } else {
      const s = loadSessionState(sessionId);
      if (s) {
        s.status = 'exited';
        s.exitCode = exitCode;
        s.signal = signal ?? undefined;
        s.exitedAt = new Date().toISOString();
        saveSessionState(s);
      }
    }
    emitEvent('subprocess_exit', {
      sessionId,
      exitCode,
      signal: signal ?? null,
      agentFolder,
    });
    logger.info({ sessionId, exitCode, signal }, 'Subprocess exited');
  });

  liveSessions.set(sessionId, { ptyProcess, state });

  if (on_exit) {
    const handlerId = `handler-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createHandler({
      id: handlerId,
      group_folder: agentFolder,
      prompt: on_exit,
      context_mode: 'agent',
      event_type: 'subprocess_exit',
      filter: JSON.stringify({ sessionId }),
      cron: null,
      next_run: null,
      cooldown_ms: 0,
      max_triggers: 1,
      status: 'active',
      created_at: new Date().toISOString(),
    });
  }

  if (on_notification) {
    const handlerId = `handler-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createHandler({
      id: handlerId,
      group_folder: agentFolder,
      prompt: on_notification,
      context_mode: 'agent',
      event_type: 'subprocess_notification',
      filter: JSON.stringify({ sessionId }),
      cron: null,
      next_run: null,
      cooldown_ms: 0,
      max_triggers: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });
  }

  logger.info(
    { sessionId, command: params.command, pid: ptyProcess.pid, agentFolder },
    'Subprocess started',
  );
  return sessionId;
}

export function readSubprocessOutput(
  sessionId: string,
  offset: number = 0,
): { output: string; nextOffset: number } {
  const outputFile = path.join(SUBPROCESSES_DIR, `${sessionId}.output`);
  if (!fs.existsSync(outputFile)) return { output: '', nextOffset: offset };

  const stats = fs.statSync(outputFile);
  if (stats.size <= offset) return { output: '', nextOffset: offset };

  const fd = fs.openSync(outputFile, 'r');
  const size = stats.size - offset;
  const buffer = Buffer.alloc(size);
  fs.readSync(fd, buffer, 0, size, offset);
  fs.closeSync(fd);

  return { output: buffer.toString('utf-8'), nextOffset: stats.size };
}

export function writeSubprocessInput(sessionId: string, data: string): boolean {
  const live = liveSessions.get(sessionId);
  if (!live) return false;
  try {
    live.ptyProcess.write(data);
    return true;
  } catch {
    return false;
  }
}

export function pollSubprocess(sessionId: string): SessionState | null {
  const live = liveSessions.get(sessionId);
  if (live) return { ...live.state };
  return loadSessionState(sessionId);
}

export function killSubprocess(sessionId: string): boolean {
  const live = liveSessions.get(sessionId);
  if (!live) return false;
  try {
    live.ptyProcess.kill();
    return true;
  } catch {
    return false;
  }
}

export function listSubprocesses(): SessionState[] {
  const results: SessionState[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(SUBPROCESSES_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return results;
  }

  for (const file of files) {
    const sessionId = file.replace('.json', '');
    const live = liveSessions.get(sessionId);
    if (live) {
      results.push({ ...live.state });
    } else {
      const state = loadSessionState(sessionId);
      if (state) results.push(state);
    }
  }

  return results.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
