import { CronExpressionParser } from 'cron-parser';

import { ODYSSEY_HANDLER_PREFIX, ODYSSEY_PROMPT, TIMEZONE } from './config.js';
import {
  createHandler,
  deleteHandler,
  getAllHandlers,
  updateHandler,
} from './db.js';
import { logger } from './logger.js';
import { OdysseyConfig, RegisteredGroup } from './types.js';

/**
 * Convert a human-friendly interval like "30m", "1h", "6h", "1d"
 * into a cron expression.
 */
export function intervalToCron(interval: string): string {
  const match = interval.match(/^(\d+)(m|h|d)$/);
  if (!match) {
    throw new Error(`Invalid interval format: "${interval}". Use e.g. "30m", "1h", "6h", "1d".`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'm':
      if (value < 1 || value > 59) throw new Error(`Invalid minute interval: ${value}`);
      return `*/${value} * * * *`;
    case 'h':
      if (value < 1 || value > 23) throw new Error(`Invalid hour interval: ${value}`);
      return `0 */${value} * * *`;
    case 'd':
      if (value < 1 || value > 28) throw new Error(`Invalid day interval: ${value}`);
      return `0 9 */${value} * *`; // Run at 9 AM
    default:
      throw new Error(`Unknown interval unit: ${unit}`);
  }
}

/**
 * Check if the current time falls within a quiet period.
 * Handles overnight ranges like { start: "23:00", end: "07:00" }.
 */
export function isInQuietPeriod(quiet: NonNullable<OdysseyConfig['quiet']>): boolean {
  const now = new Date();
  const localTime = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }));
  const currentMinutes = localTime.getHours() * 60 + localTime.getMinutes();

  const [startH, startM] = quiet.start.split(':').map(Number);
  const [endH, endM] = quiet.end.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    // Same-day range, e.g. "09:00" to "17:00"
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Overnight range, e.g. "23:00" to "07:00"
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

/**
 * Register or update Odyssey handlers for all groups that have odyssey config.
 * Called once on startup.
 */
export function registerOdysseyHandlers(
  groups: Record<string, RegisteredGroup>,
): void {
  const existingHandlers = getAllHandlers();
  const odysseyHandlers = new Map(
    existingHandlers
      .filter((h) => h.id.startsWith(ODYSSEY_HANDLER_PREFIX))
      .map((h) => [h.id, h]),
  );

  const seenHandlerIds = new Set<string>();

  for (const group of Object.values(groups)) {
    const handlerId = `${ODYSSEY_HANDLER_PREFIX}${group.folder}`;
    seenHandlerIds.add(handlerId);

    const existing = odysseyHandlers.get(handlerId);

    if (!group.odyssey) {
      // No odyssey config — pause existing handler if any
      if (existing && existing.status === 'active') {
        updateHandler(handlerId, { status: 'paused' });
        logger.info({ handlerId }, 'Odyssey handler paused (config removed)');
      }
      continue;
    }

    const cron = intervalToCron(group.odyssey.interval);

    if (existing) {
      // Handler exists — check if cron changed
      if (existing.cron !== cron) {
        // Delete and recreate with new cron
        deleteHandler(handlerId);
        logger.info({ handlerId, oldCron: existing.cron, newCron: cron }, 'Odyssey handler recreated (interval changed)');
      } else {
        // Cron matches — ensure active and prompt is current
        const updates: Parameters<typeof updateHandler>[1] = {};
        if (existing.status !== 'active') updates.status = 'active';
        if (existing.prompt !== ODYSSEY_PROMPT) updates.prompt = ODYSSEY_PROMPT;
        if (Object.keys(updates).length > 0) {
          updateHandler(handlerId, updates);
          logger.info({ handlerId }, 'Odyssey handler updated');
        }
        continue;
      }
    }

    // Create new handler
    const nextRun = CronExpressionParser.parse(cron, { tz: TIMEZONE })
      .next()
      .toISOString();

    const filter = JSON.stringify({ handler_id: handlerId });

    createHandler({
      id: handlerId,
      group_folder: group.folder,
      prompt: ODYSSEY_PROMPT,
      context_mode: 'isolated',
      event_type: 'cron_trigger',
      filter,
      cron,
      next_run: nextRun,
      cooldown_ms: 0,
      max_triggers: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    logger.info(
      { handlerId, folder: group.folder, cron, nextRun },
      'Odyssey handler created',
    );
  }

  // Pause any odyssey handlers for groups that no longer exist
  for (const [handlerId, handler] of odysseyHandlers) {
    if (!seenHandlerIds.has(handlerId) && handler.status === 'active') {
      updateHandler(handlerId, { status: 'paused' });
      logger.info({ handlerId }, 'Odyssey handler paused (group removed)');
    }
  }
}
