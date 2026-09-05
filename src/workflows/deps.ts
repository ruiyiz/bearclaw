import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { resolveRegistry } from '../agent-registry.js';
import { runContainerAgent } from '../agent/runner.js';
import { DATA_DIR, MAIN_AGENT_FOLDER, PUBLIC_URL, RUN_DIR } from '../config.js';
import { emitEvent, getDb } from '../db.js';
import { logger } from '../logger.js';
import { signActionToken } from '../server/auth.js';
import { loadRegistry } from '../store/agents.js';
import { getContextFile } from '../store/context.js';
import type { RegisteredAgent } from '../types.js';
import { loadJson, saveJson } from '../utils/json.js';
import type { EngineDeps, MatchedEvent, ShellRunResult } from './runtime.js';

function agentForFolder(folder: string): RegisteredAgent {
  const registry = loadRegistry();
  try {
    const resolved = resolveRegistry(registry);
    const matches = Object.entries(resolved).filter(
      ([, a]) => a.folder === folder,
    );
    const primary = matches.find(([, a]) => a.primary) ?? matches[0];
    if (primary) return primary[1];
  } catch (err) {
    logger.warn({ err, folder }, 'workflow: registry resolve failed');
  }
  return {
    name: folder,
    folder,
    trigger: '',
    added_at: new Date().toISOString(),
  };
}

function sessionsPath(): string {
  return path.join(DATA_DIR, 'sessions.json');
}

export const defaultDeps: EngineDeps = {
  async runAgent(spec) {
    const group = agentForFolder(spec.folder);
    const out = await runContainerAgent(group, {
      prompt: spec.prompt,
      sessionId: spec.sessionId,
      agentFolder: spec.folder,
      chatJid: spec.chatJid,
      isMain: spec.folder === MAIN_AGENT_FOLDER,
      isEventHandler: true,
      model: spec.model,
      effort: spec.effort,
      outputSchema: spec.outputSchema as Record<string, unknown> | undefined,
      allowedTools: spec.allowedTools,
      maxTurns: spec.maxTurns,
      timeoutMs: spec.timeoutMs,
      abortSignal: spec.signal,
    });
    return {
      status: out.status,
      text: out.result,
      structured: out.structuredOutput,
      sessionId: out.newSessionId,
      error: out.error,
      timedOut: out.timedOut,
    };
  },

  runShell(spec) {
    return new Promise<ShellRunResult>((resolve) => {
      const child = spawn('/bin/bash', ['-lc', spec.cmd], {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, spec.timeoutMs);
      const onAbort = () => child.kill('SIGKILL');
      spec.signal.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (err) => {
        clearTimeout(timer);
        spec.signal.removeEventListener('abort', onAbort);
        resolve({ code: -1, stdout, stderr: String(err), timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        spec.signal.removeEventListener('abort', onAbort);
        resolve({ code: code ?? -1, stdout, stderr, timedOut });
      });
      if (spec.stdin !== undefined) child.stdin.end(spec.stdin);
      else child.stdin.end();
    });
  },

  // Reuses the IPC message watcher in index.ts: an empty chatJid means
  // "the folder's primary channel, else fan out".
  async send(spec) {
    const dir = path.join(RUN_DIR, 'ipc', spec.folder, 'messages');
    fs.mkdirSync(dir, { recursive: true });
    const write = (data: object) => {
      const file = path.join(
        dir,
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
      );
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
      fs.renameSync(`${file}.tmp`, file);
    };
    const base = {
      type: 'message',
      chatJid: spec.to ?? null,
      agentFolder: spec.folder,
      timestamp: new Date().toISOString(),
    };
    if (spec.media?.length) {
      for (const [i, filePath] of spec.media.entries())
        write({
          ...base,
          text: i === 0 ? spec.text : null,
          mediaType: 'document',
          filePath,
        });
    } else {
      write({
        ...base,
        text: spec.text,
        ...(spec.choices?.length ? { choices: spec.choices } : {}),
      });
    }
    return { targets: spec.to ? [spec.to] : ['primary'] };
  },

  emitEvent(type, payload) {
    return emitEvent(type, payload);
  },

  latestEventId() {
    const row = getDb().prepare(`SELECT MAX(id) AS id FROM events`).get() as
      | { id: number | null }
      | undefined;
    return row?.id ?? 0;
  },

  findEvent(type, filter, opts): MatchedEvent | null {
    const clauses = ['type = ?'];
    const params: unknown[] = [type];
    if (opts.afterId !== undefined) {
      clauses.push('id > ?');
      params.push(opts.afterId);
    }
    if (opts.sinceIso) {
      clauses.push('emitted_at >= ?');
      params.push(opts.sinceIso);
    }
    const rows = getDb()
      .prepare(
        `SELECT id, type, payload, emitted_at FROM events
         WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT 200`,
      )
      .all(...params) as {
      id: number;
      type: string;
      payload: string;
      emitted_at: string;
    }[];
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        payload = {};
      }
      if (filter) {
        let ok = true;
        for (const [k, v] of Object.entries(filter))
          if (payload[k] !== v) {
            ok = false;
            break;
          }
        if (!ok) continue;
      }
      return {
        id: row.id,
        type: row.type,
        payload,
        emitted_at: row.emitted_at,
      };
    }
    return null;
  },

  readTemplateFile(file, folder) {
    const content =
      getContextFile('agent', folder, file) ??
      getContextFile('shared', '', file);
    if (content === undefined)
      throw new Error(`template file not found: ${file}`);
    return content;
  },

  approvalLink(waitId, action, ttlMs) {
    try {
      const token = signActionToken(waitId, action, Math.round(ttlMs / 1000));
      return `${PUBLIC_URL}/r/${token}`;
    } catch {
      return null;
    }
  },

  getChatSessionId(folder) {
    const sessions = loadJson<Record<string, string | boolean>>(
      sessionsPath(),
      {},
    );
    const value = sessions[folder];
    return typeof value === 'string' ? value : undefined;
  },

  setChatSessionId(folder, sessionId) {
    const sessions = loadJson<Record<string, string | boolean>>(
      sessionsPath(),
      {},
    );
    saveJson(sessionsPath(), { ...sessions, [folder]: sessionId });
  },

  now: () => new Date(),
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  env: process.env,
};
