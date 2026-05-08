/**
 * Conversation checkpoint + archive.
 *
 * Replaces the old `memory-flusher.ts`. Keeps the public API names so
 * callers in `index.ts` and the dream orchestrator don't need to change.
 *
 * Two write paths:
 *
 *   1. Periodic checkpoint (every MEMORY_FLUSH_INTERVAL): full transcript
 *      written to `var/agents/{folder}/checkpoints/{sessionId}.md` using
 *      the same human-readable format as a final archive. Single file
 *      per session, overwritten each tick. Crash-safety material — never
 *      indexed by FTS / vec / QMD.
 *
 *   2. Session-end archive (called by the dream-cycle reset): writes the
 *      finalized transcript to `var/agents/{folder}/conversations/
 *      {date}-{name}.md`, then deletes the corresponding checkpoint.
 *
 * On startup, `recoverOrphanedCheckpoints` scans `checkpoints/` for files
 * whose sessionId is no longer in `sessions.json` and promotes each to a
 * recovered conversation archive.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { MEMORY_FLUSH_INTERVAL, agentVarDir, localDate } from '../config.js';
import { logger } from '../logger.js';
import {
  formatTranscriptMarkdown,
  generateFallbackName,
  getSessionSummary,
  parseTranscript,
  sanitizeFilename,
} from './runner.js';

interface MemoryFlusherDeps {
  getSessions: () => Record<string, string>;
}

function getTranscriptPath(cwd: string, sessionId: string): string {
  const encodedCwd = cwd.replace(/[/.]/g, '-');
  return path.join(
    os.homedir(),
    '.claude',
    'projects',
    encodedCwd,
    `${sessionId}.jsonl`,
  );
}

function checkpointPath(varDir: string, sessionId: string): string {
  return path.join(varDir, 'checkpoints', `${sessionId}.md`);
}

function writeCheckpoint(varDir: string, sessionId: string): void {
  const transcriptPath = getTranscriptPath(varDir, sessionId);
  if (!fs.existsSync(transcriptPath)) return;

  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const messages = parseTranscript(content);
  if (messages.length === 0) return;

  const summary = getSessionSummary(sessionId, transcriptPath);
  const cpPath = checkpointPath(varDir, sessionId);
  fs.mkdirSync(path.dirname(cpPath), { recursive: true });
  const tmp = `${cpPath}.tmp`;
  fs.writeFileSync(tmp, formatTranscriptMarkdown(messages, summary));
  fs.renameSync(tmp, cpPath);
}

function archiveSessionFinal(varDir: string, sessionId: string): void {
  const transcriptPath = getTranscriptPath(varDir, sessionId);
  if (!fs.existsSync(transcriptPath)) return;

  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const messages = parseTranscript(content);
  if (messages.length === 0) return;

  const summary = getSessionSummary(sessionId, transcriptPath);
  const name = summary ? sanitizeFilename(summary) : generateFallbackName();
  const date = localDate();
  const conversationsDir = path.join(varDir, 'conversations');
  fs.mkdirSync(conversationsDir, { recursive: true });
  const filename = `${date}-${name}.md`;
  const filePath = path.join(conversationsDir, filename);
  fs.writeFileSync(filePath, formatTranscriptMarkdown(messages, summary));
  logger.info({ filePath }, 'Conversation archived');

  // Drop the checkpoint — clean session-end no longer needs it.
  const cpPath = checkpointPath(varDir, sessionId);
  if (fs.existsSync(cpPath)) {
    try {
      fs.rmSync(cpPath);
    } catch (err) {
      logger.warn({ err, cpPath }, 'Failed to remove checkpoint after archive');
    }
  }
}

/**
 * No-op kept for callsite compatibility. The new checkpoint flow rewrites
 * the full transcript each tick, so there is no incremental cursor.
 */
export function initFlushCursors(_sessions: Record<string, string>): void {
  // intentionally empty
}

/**
 * Promote any orphaned `checkpoints/*.md` (sessionId no longer live) to a
 * recovered conversation archive. Called once at startup per agent
 * folder.
 */
export function recoverOrphanedCheckpoints(
  folder: string,
  liveSessionIds: Set<string>,
): void {
  const varDir = agentVarDir(folder);
  const cpDir = path.join(varDir, 'checkpoints');
  if (!fs.existsSync(cpDir)) return;

  for (const file of fs.readdirSync(cpDir)) {
    if (!file.endsWith('.md')) continue;
    const sessionId = file.replace(/\.md$/, '');
    if (liveSessionIds.has(sessionId)) continue;

    const cpPath = path.join(cpDir, file);
    try {
      const content = fs.readFileSync(cpPath, 'utf-8');
      const date = localDate();
      const name = `recovered-${sessionId.slice(0, 8)}`;
      const conversationsDir = path.join(varDir, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });
      const target = path.join(conversationsDir, `${date}-${name}.md`);
      fs.writeFileSync(target, content);
      fs.rmSync(cpPath);
      logger.info(
        { folder, sessionId, target },
        'Recovered orphaned checkpoint',
      );
    } catch (err) {
      logger.warn(
        { err, folder, sessionId },
        'Failed to recover orphaned checkpoint',
      );
    }
  }
}

export function flushBeforeSessionClear(
  folder: string,
  sessionId: string,
): void {
  const varDir = agentVarDir(folder);
  try {
    archiveSessionFinal(varDir, sessionId);
  } catch (err) {
    logger.error({ err, folder }, 'Conversation archive error');
  }
}

export function startMemoryFlusher(deps: MemoryFlusherDeps): void {
  const tick = () => {
    const sessions = deps.getSessions();
    for (const [folder, sessionId] of Object.entries(sessions)) {
      const varDir = agentVarDir(folder);
      try {
        writeCheckpoint(varDir, sessionId);
      } catch (err) {
        logger.error({ err, folder }, 'Conversation checkpoint error');
      }
    }
    setTimeout(tick, MEMORY_FLUSH_INTERVAL);
  };

  setTimeout(tick, MEMORY_FLUSH_INTERVAL);
  logger.info(
    { intervalMs: MEMORY_FLUSH_INTERVAL },
    'Conversation checkpoint started',
  );
}
