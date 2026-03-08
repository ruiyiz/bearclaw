import { CronExpressionParser } from 'cron-parser';

import { ODYSSEY_HANDLER_PREFIX, ODYSSEY_PROMPT, TIMEZONE } from './config.js';
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
 * Register or update Odyssey handlers for all agents that have odyssey config.
 * Called once on startup.
 */
export function registerOdysseyHandlers(
  agents: Record<string, RegisteredAgent>,
): void {
  const existingHandlers = getAllHandlers();
  const odysseyHandlers = new Map(
    existingHandlers
      .filter((h) => h.id.startsWith(ODYSSEY_HANDLER_PREFIX))
      .map((h) => [h.id, h]),
  );

  const seenHandlerIds = new Set<string>();

  for (const agent of Object.values(agents)) {
    const handlerId = `${ODYSSEY_HANDLER_PREFIX}${agent.folder}`;
    seenHandlerIds.add(handlerId);

    const existing = odysseyHandlers.get(handlerId);

    if (!agent.odyssey) {
      // No odyssey config — pause existing handler if any
      if (existing && existing.status === 'active') {
        updateHandler(handlerId, { status: 'paused' });
        logger.info({ handlerId }, 'Odyssey handler paused (config removed)');
      }
      continue;
    }

    const cron = intervalToCron(agent.odyssey.interval);

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
      group_folder: agent.folder,
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
      { handlerId, folder: agent.folder, cron, nextRun },
      'Odyssey handler created',
    );
  }

  // Pause any odyssey handlers for agents that no longer exist
  for (const [handlerId, handler] of odysseyHandlers) {
    if (!seenHandlerIds.has(handlerId) && handler.status === 'active') {
      updateHandler(handlerId, { status: 'paused' });
      logger.info({ handlerId }, 'Odyssey handler paused (agent removed)');
    }
  }
}
