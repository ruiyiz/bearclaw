/**
 * Daily conversation archive (DB-sourced).
 *
 * One job: at 01:00 local each day, render yesterday's messages for every
 * registered agent folder into `var/agents/{folder}/conversations/{date}.md`.
 * gbrain's sync cron picks the files up, git-commits them, and runs
 * `gbrain sync --all` to ingest.
 *
 * Source moved from per-session checkpoints (gone) to the `messages` table.
 * The file boundary stays so gbrain's ingestion contract is unchanged.
 */

import fs from 'fs';
import path from 'path';

import { TIMEZONE, agentVarDir } from '../config.js';
import { getDb, getMessagesInRange, type StoredMessage } from '../db.js';
import { logger } from '../logger.js';
import type { RegisteredAgent } from '../types.js';

interface DailyFlushDeps {
  registeredAgents: () => Record<string, RegisteredAgent>;
}

function localDateString(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

function yesterdayLocalString(now: Date): string {
  const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return localDateString(y);
}

function localDayBoundsUtc(localDate: string): { start: string; end: string } {
  // Probe-and-correct: take the desired local date at midnight, compute the
  // current zone offset for that instant, then shift to UTC.
  const naive = new Date(`${localDate}T00:00:00Z`);
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
  const [datePart, timePart] = localStr.split(', ');
  const [m, d, y] = datePart.split('/').map(Number);
  const [h, mi, s] = timePart.split(':').map(Number);
  const localAsUtc = Date.UTC(y, m - 1, d, h, mi, s);
  const offsetMs = naive.getTime() - localAsUtc;
  const startUtc = new Date(naive.getTime() + offsetMs);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { start: startUtc.toISOString(), end: endUtc.toISOString() };
}

function jidsForFolder(
  folder: string,
  registered: Record<string, RegisteredAgent>,
): string[] {
  // All registered IM/email/web jids for the folder. Web rows live under many
  // composite jids (`web:<folder>:<sessionId>`); pull them by prefix instead
  // of by the bare `web:<folder>` registry key.
  const jids = new Set<string>();
  for (const [jid, agent] of Object.entries(registered)) {
    if (agent.folder !== folder) continue;
    if (jid.startsWith('web:')) continue;
    jids.add(jid);
  }
  return [...jids];
}

function mergeAndSort(rows: StoredMessage[]): StoredMessage[] {
  return rows.slice().sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
}

function formatRows(
  folder: string,
  date: string,
  rows: StoredMessage[],
): string {
  if (rows.length === 0) return '';
  const header = `# ${folder} — ${date}\n`;
  const body = rows
    .map((m) => {
      const who = m.is_from_me === 1 ? 'Assistant' : m.sender_name || m.sender;
      return `**${who}** [${m.timestamp}]\n\n${m.content}`;
    })
    .join('\n\n---\n\n');
  return `${header}\n${body}\n`;
}

function listFolders(registered: Record<string, RegisteredAgent>): string[] {
  const set = new Set<string>();
  for (const a of Object.values(registered)) set.add(a.folder);
  return [...set];
}

async function flushFolder(
  folder: string,
  date: string,
  registered: Record<string, RegisteredAgent>,
): Promise<void> {
  const { start, end } = localDayBoundsUtc(date);
  const directJids = jidsForFolder(folder, registered);
  // Web rows live under `web:<folder>:<sessionId>`. Pull them via a LIKE
  // pattern to avoid enumerating every session id here.
  const webRows = getDb()
    .prepare(
      `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
       FROM messages
       WHERE chat_jid LIKE ?
         AND timestamp >= ? AND timestamp < ?
       ORDER BY timestamp`,
    )
    .all(`web:${folder}:%`, start, end) as StoredMessage[];
  const direct = getMessagesInRange(directJids, start, end);
  const rows = mergeAndSort([...direct, ...webRows]);
  if (rows.length === 0) return;

  const out = formatRows(folder, date, rows);
  const dir = path.join(agentVarDir(folder), 'conversations');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${date}.md`);
  fs.writeFileSync(target, out);
  logger.info(
    { folder, date, rows: rows.length, target },
    'Daily conversation archive written',
  );
}

async function flushAll(date: string, deps: DailyFlushDeps): Promise<void> {
  const registered = deps.registeredAgents();
  for (const folder of listFolders(registered)) {
    try {
      await flushFolder(folder, date, registered);
    } catch (err) {
      logger.error({ err, folder, date }, 'Daily conversation flush failed');
    }
  }
}

export function startDailyConversationFlush(deps: DailyFlushDeps): void {
  const fire = async () => {
    const date = yesterdayLocalString(new Date());
    await flushAll(date, deps);
    setTimeout(fire, msUntilNextLocalHour(1));
  };

  // Catch-up on boot: render yesterday's archive in case the service was
  // down at 1am. Idempotent — overwriting the same file is fine.
  void flushAll(yesterdayLocalString(new Date()), deps).catch((err) => {
    logger.error({ err }, 'Initial conversation flush failed');
  });

  const wait = msUntilNextLocalHour(1);
  setTimeout(fire, wait);
  logger.info(
    { firstRunInMs: wait, hour: 1, tz: TIMEZONE },
    'Daily conversation flush scheduled',
  );
}

function msUntilNextLocalHour(hour: number): number {
  const now = new Date();
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const candidate = nextLocalHourUTC(now, hour, dayOffset);
    if (candidate.getTime() > now.getTime()) {
      return candidate.getTime() - now.getTime();
    }
  }
  return 24 * 60 * 60 * 1000;
}

function nextLocalHourUTC(now: Date, hour: number, dayOffset: number): Date {
  const base = new Date(now.getTime() + dayOffset * 86_400_000);
  const ymd = base.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const naive = new Date(`${ymd}T${String(hour).padStart(2, '0')}:00:00Z`);
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
  const [datePart, timePart] = localStr.split(', ');
  const [m, d, y] = datePart.split('/').map(Number);
  const [h, mi, s] = timePart.split(':').map(Number);
  const localAsUtc = Date.UTC(y, m - 1, d, h, mi, s);
  const offsetMs = naive.getTime() - localAsUtc;
  return new Date(naive.getTime() + offsetMs);
}
