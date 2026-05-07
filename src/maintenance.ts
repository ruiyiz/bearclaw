import fs from 'fs';
import path from 'path';

import { AGENTS_VAR_DIR, LOG_DIR } from './config.js';
import { logger } from './logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const AGENT_LOG_RETENTION_DAYS = 30;
const IMSG_LOG_MAX_AGE_DAYS = 7;
const IMSG_LOG_MAX_BYTES = 50 * 1024 * 1024;
const MAINTENANCE_INTERVAL_MS = DAY_MS;

function pruneAgentLogs(): void {
  if (!fs.existsSync(AGENTS_VAR_DIR)) return;
  const cutoff = Date.now() - AGENT_LOG_RETENTION_DAYS * DAY_MS;
  let removed = 0;

  for (const entry of fs.readdirSync(AGENTS_VAR_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const logsDir = path.join(AGENTS_VAR_DIR, entry.name, 'logs');
    if (!fs.existsSync(logsDir)) continue;

    for (const file of fs.readdirSync(logsDir)) {
      if (!file.startsWith('agent-') || !file.endsWith('.log')) continue;
      const fp = path.join(logsDir, file);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          removed++;
        }
      } catch (err) {
        logger.debug({ err, fp }, 'Failed to prune agent log');
      }
    }
  }

  if (removed > 0) {
    logger.info(
      { removed, retentionDays: AGENT_LOG_RETENTION_DAYS },
      'Pruned old agent logs',
    );
  }
}

function rotateImsgWatchLog(): void {
  const file = path.join(LOG_DIR, 'imsg-watch.jsonl');
  if (!fs.existsSync(file)) return;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    logger.debug({ err, file }, 'Failed to stat imsg-watch log');
    return;
  }

  const ageMs = Date.now() - stat.mtimeMs;
  const overAge = ageMs >= IMSG_LOG_MAX_AGE_DAYS * DAY_MS;
  const overSize = stat.size >= IMSG_LOG_MAX_BYTES;
  if (!overAge && !overSize) return;

  // Truncate in place. Swift watcher opens the file with O_APPEND, so the
  // next write lands at offset 0 and the file grows fresh — no fd reopen
  // needed. Older entries are unrecoverable; this is intentional.
  try {
    fs.truncateSync(file, 0);
    logger.info(
      { sizeBefore: stat.size, ageDays: ageMs / DAY_MS },
      'Truncated imsg-watch log',
    );
  } catch (err) {
    logger.warn({ err, file }, 'Failed to truncate imsg-watch log');
  }
}

function runMaintenance(): void {
  try {
    pruneAgentLogs();
  } catch (err) {
    logger.error({ err }, 'Agent-log prune failed');
  }
  try {
    rotateImsgWatchLog();
  } catch (err) {
    logger.error({ err }, 'imsg-watch rotation failed');
  }
}

export function startMaintenance(): void {
  runMaintenance();
  setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS).unref();
  logger.info('Maintenance loop started');
}
