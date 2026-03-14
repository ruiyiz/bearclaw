import { CronExpressionParser } from 'cron-parser';

import { HEARTBEAT_HANDLER_PREFIX, HEARTBEAT_PROMPT, TIMEZONE } from './config.js';
import {
  createHandler,
  deleteHandler,
  getAllHandlers,
  updateHandler,
} from './db.js';
import { logger } from './logger.js';
import { RegisteredAgent } from './types.js';
import { intervalToCron, isInQuietPeriod } from './time-utils.js';

/**
 * Register or update Heartbeat handlers for all agents that have heartbeat config.
 * Called once on startup.
 */
export function registerHeartbeatHandlers(
  agents: Record<string, RegisteredAgent>,
): void {
  const existingHandlers = getAllHandlers();
  const heartbeatHandlers = new Map(
    existingHandlers
      .filter((h) => h.id.startsWith(HEARTBEAT_HANDLER_PREFIX))
      .map((h) => [h.id, h]),
  );

  const seenHandlerIds = new Set<string>();

  for (const agent of Object.values(agents)) {
    const handlerId = `${HEARTBEAT_HANDLER_PREFIX}${agent.folder}`;
    seenHandlerIds.add(handlerId);

    const existing = heartbeatHandlers.get(handlerId);

    if (!agent.heartbeat) {
      if (existing && existing.status === 'active') {
        updateHandler(handlerId, { status: 'paused' });
        logger.info({ handlerId }, 'Heartbeat handler paused (config removed)');
      }
      continue;
    }

    const cron = intervalToCron(agent.heartbeat.interval);

    if (existing) {
      if (existing.cron !== cron) {
        deleteHandler(handlerId);
        logger.info({ handlerId, oldCron: existing.cron, newCron: cron }, 'Heartbeat handler recreated (interval changed)');
      } else {
        const updates: Parameters<typeof updateHandler>[1] = {};
        if (existing.status !== 'active') updates.status = 'active';
        if (existing.prompt !== HEARTBEAT_PROMPT) updates.prompt = HEARTBEAT_PROMPT;
        if (Object.keys(updates).length > 0) {
          updateHandler(handlerId, updates);
          logger.info({ handlerId }, 'Heartbeat handler updated');
        }
        continue;
      }
    }

    const nextRun = CronExpressionParser.parse(cron, { tz: TIMEZONE })
      .next()
      .toISOString();

    const filter = JSON.stringify({ handler_id: handlerId });

    createHandler({
      id: handlerId,
      group_folder: agent.folder,
      prompt: HEARTBEAT_PROMPT,
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
      { handlerId, folder: agent.folder, cron, nextRun },
      'Heartbeat handler created',
    );
  }

  for (const [handlerId, handler] of heartbeatHandlers) {
    if (!seenHandlerIds.has(handlerId) && handler.status === 'active') {
      updateHandler(handlerId, { status: 'paused' });
      logger.info({ handlerId }, 'Heartbeat handler paused (agent removed)');
    }
  }
}
