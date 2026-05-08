/**
 * Conversation checkpoint + daily archive.
 *
 * Three write paths:
 *
 *   1. Periodic checkpoint (every MEMORY_FLUSH_INTERVAL): full transcript
 *      written to `var/agents/{folder}/checkpoints/{sessionId}.md`. Single
 *      file per session, overwritten each tick. Crash-safety material.
 *
 *   2. /new (flushBeforeSessionClear): writes one final checkpoint for the
 *      session being cleared, leaves the file in `checkpoints/`. The daily
 *      consolidator picks it up at 1am local.
 *
 *   3. Daily 1am consolidator (consolidateStaleCheckpoints): groups every
 *      checkpoint older than today (by mtime) by date, appends each into
 *      `conversations/{date}.md`, deletes the consumed checkpoint. Live
 *      sessions are skipped. Result: one conversation file per day per
 *      agent, matching the old daily-rollup contract without the dream
 *      cycle.
 *
 * Startup also runs the consolidator so a crash that left stale checkpoints
 * around gets cleaned up immediately rather than waiting for the next 1am.
 */

import fs from 'fs';
import path from 'path';

import {
  AGENTS_VAR_DIR,
  MEMORY_FLUSH_INTERVAL,
  TIMEZONE,
  agentVarDir,
  localDate,
} from '../config.js';
import { logger } from '../logger.js';
import {
  formatTranscriptMarkdown,
  getSessionSummary,
  loadParsedTranscript,
} from './runner.js';

interface MemoryFlusherDeps {
  getSessions: () => Record<string, string>;
}

function checkpointPath(varDir: string, sessionId: string): string {
  return path.join(varDir, 'checkpoints', `${sessionId}.md`);
}

async function writeCheckpoint(
  varDir: string,
  sessionId: string,
): Promise<void> {
  const messages = await loadParsedTranscript(sessionId, varDir);
  if (messages.length === 0) return;

  const summary = getSessionSummary(sessionId, varDir);
  const cpPath = checkpointPath(varDir, sessionId);
  fs.mkdirSync(path.dirname(cpPath), { recursive: true });
  const tmp = `${cpPath}.tmp`;
  fs.writeFileSync(tmp, formatTranscriptMarkdown(messages, summary));
  fs.renameSync(tmp, cpPath);
}

function dateFromMtime(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

/**
 * Consolidate every checkpoint that does not belong to a live session into
 * the day's conversation file. Idempotent — re-runs are safe because the
 * source file is removed after a successful append.
 */
function consolidateAgentCheckpoints(
  folder: string,
  liveSessionIds: Set<string>,
): { promoted: number } {
  const varDir = agentVarDir(folder);
  const cpDir = path.join(varDir, 'checkpoints');
  if (!fs.existsSync(cpDir)) return { promoted: 0 };

  const today = localDate();
  const conversationsDir = path.join(varDir, 'conversations');
  fs.mkdirSync(conversationsDir, { recursive: true });

  const files = fs.readdirSync(cpDir).filter((f) => f.endsWith('.md'));
  type Entry = { path: string; mtime: number; date: string };
  const byDate = new Map<string, Entry[]>();

  for (const f of files) {
    const sessionId = f.replace(/\.md$/, '');
    if (liveSessionIds.has(sessionId)) continue;
    const fp = path.join(cpDir, f);
    let mtime: number;
    try {
      mtime = fs.statSync(fp).mtimeMs;
    } catch {
      continue;
    }
    const date = dateFromMtime(mtime);
    if (date === today) continue; // wait until tomorrow's 1am
    const list = byDate.get(date) ?? [];
    list.push({ path: fp, mtime, date });
    byDate.set(date, list);
  }

  let promoted = 0;
  for (const [date, entries] of byDate) {
    entries.sort((a, b) => a.mtime - b.mtime);
    const target = path.join(conversationsDir, `${date}.md`);
    const sections: string[] = [];
    if (fs.existsSync(target)) {
      sections.push(fs.readFileSync(target, 'utf-8').trim());
    }
    for (const e of entries) {
      try {
        sections.push(fs.readFileSync(e.path, 'utf-8').trim());
      } catch (err) {
        logger.warn({ err, path: e.path }, 'Failed to read checkpoint');
      }
    }
    fs.writeFileSync(
      target,
      sections.filter(Boolean).join('\n\n---\n\n') + '\n',
    );
    for (const e of entries) {
      try {
        fs.rmSync(e.path);
        promoted += 1;
      } catch (err) {
        logger.warn(
          { err, path: e.path },
          'Failed to remove consolidated checkpoint',
        );
      }
    }
    logger.info(
      { folder, date, sessions: entries.length, target },
      'Consolidated checkpoints into daily conversation',
    );
  }
  return { promoted };
}

function listAgentFolders(): string[] {
  if (!fs.existsSync(AGENTS_VAR_DIR)) return [];
  return fs
    .readdirSync(AGENTS_VAR_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function consolidateAllAgents(liveSessionIds: Set<string>): void {
  for (const folder of listAgentFolders()) {
    try {
      consolidateAgentCheckpoints(folder, liveSessionIds);
    } catch (err) {
      logger.error({ err, folder }, 'Daily checkpoint consolidation failed');
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
 * Startup hook: consolidate any orphan checkpoint files from previous days
 * that are not associated with a currently live session. Replaces the old
 * "recover orphaned checkpoints" path which promoted each crash residue
 * into its own `recovered-…` conversation file.
 */
export function recoverOrphanedCheckpoints(
  folder: string,
  liveSessionIds: Set<string>,
): void {
  consolidateAgentCheckpoints(folder, liveSessionIds);
}

/**
 * Called from /new before the session id is dropped. Persists the latest
 * transcript to the session's checkpoint so the daily consolidator at 1am
 * picks it up. Does NOT write to `conversations/` — that is the daily
 * consolidator's job.
 */
export function flushBeforeSessionClear(
  folder: string,
  sessionId: string,
): void {
  const varDir = agentVarDir(folder);
  // Fire-and-forget: callers (e.g. /new) drop the session id immediately
  // after this returns; the SDK's getSessionMessages reads the JSONL on disk,
  // which is unaffected by clearing the in-memory session map.
  writeCheckpoint(varDir, sessionId).catch((err) => {
    logger.error({ err, folder }, 'Final checkpoint write failed');
  });
}

export function startMemoryFlusher(deps: MemoryFlusherDeps): void {
  const tick = async () => {
    const sessions = deps.getSessions();
    await Promise.all(
      Object.entries(sessions).map(async ([folder, sessionId]) => {
        const varDir = agentVarDir(folder);
        try {
          await writeCheckpoint(varDir, sessionId);
        } catch (err) {
          logger.error({ err, folder }, 'Conversation checkpoint error');
        }
      }),
    );
    setTimeout(tick, MEMORY_FLUSH_INTERVAL);
  };

  setTimeout(tick, MEMORY_FLUSH_INTERVAL);
  logger.info(
    { intervalMs: MEMORY_FLUSH_INTERVAL },
    'Conversation checkpoint started',
  );
}

/**
 * Schedule the daily 1am consolidation. Computes ms until the next 01:00
 * in the configured TZ, fires once, then re-arms for 24h later. Runs once
 * immediately on start so a freshly-booted process catches yesterday's
 * stale checkpoints without waiting up to a day.
 */
export function startDailyConversationFlush(deps: MemoryFlusherDeps): void {
  const fire = () => {
    const live = new Set<string>(Object.values(deps.getSessions()));
    consolidateAllAgents(live);
    setTimeout(fire, msUntilNextLocalHour(1));
  };

  // Initial sweep handles crash residue + any checkpoints left from a
  // previous run that crossed a day boundary while the service was down.
  const live = new Set<string>(Object.values(deps.getSessions()));
  consolidateAllAgents(live);

  const wait = msUntilNextLocalHour(1);
  setTimeout(fire, wait);
  logger.info(
    { firstRunInMs: wait, hour: 1, tz: TIMEZONE },
    'Daily conversation flush scheduled',
  );
}

/**
 * Milliseconds from now until the next occurrence of the given local hour
 * in TIMEZONE. Robust against DST: re-derives the boundary by formatting
 * candidate UTC times back into the local zone rather than naive offset
 * arithmetic.
 */
function msUntilNextLocalHour(hour: number): number {
  const now = new Date();
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const candidate = nextLocalHourUTC(now, hour, dayOffset);
    if (candidate.getTime() > now.getTime()) {
      return candidate.getTime() - now.getTime();
    }
  }
  // Fallback: 24h. Should never hit.
  return 24 * 60 * 60 * 1000;
}

function nextLocalHourUTC(now: Date, hour: number, dayOffset: number): Date {
  const base = new Date(now.getTime() + dayOffset * 86_400_000);
  const ymd = base.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  // ymd is YYYY-MM-DD in the target zone for that calendar day.
  // Ask the system to interpret `${ymd}T${hh}:00:00` as if it were local-zone
  // time by computing the offset for that instant.
  const naive = new Date(`${ymd}T${String(hour).padStart(2, '0')}:00:00Z`);
  // Determine the zone offset at `naive` for TIMEZONE by formatting back.
  const localStr = naive.toLocaleString('en-US', {
    timeZone: TIMEZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  // localStr is the zone-local rendering of `naive` (which we sent as UTC).
  // Difference between intended local time and the returned local time =
  // the offset we need to subtract.
  const [datePart, timePart] = localStr.split(', ');
  const [m, d, y] = datePart.split('/').map(Number);
  const [h, mi, s] = timePart.split(':').map(Number);
  const localAsUtc = Date.UTC(y, m - 1, d, h, mi, s);
  const offsetMs = naive.getTime() - localAsUtc;
  return new Date(naive.getTime() + offsetMs);
}
