/**
 * Register or update Dream handlers for all agents.
 *
 * One `dream-{folder}` handler per registered agent folder, scheduled via
 * cron at DREAM_HOUR daily. Wired alongside the heartbeat handlers in
 * index.ts.
 */

import { CronExpressionParser } from 'cron-parser';

import {
  DREAM_ENABLED,
  DREAM_HANDLER_PREFIX,
  DREAM_HOUR,
  DREAM_REPORT_HANDLER_ID,
  DREAM_REPORT_OFFSET_MIN,
  MAIN_AGENT_FOLDER,
  TIMEZONE,
} from '../config.js';
import {
  createHandler,
  deleteHandler,
  getAllHandlers,
  updateHandler,
} from '../db.js';
import { logger } from '../logger.js';
import { Handler, RegisteredAgent } from '../types.js';

const DREAM_PROMPT = '[DREAM CYCLE — handled by orchestrator, not the agent]';

function dreamCron(): string {
  return `0 ${DREAM_HOUR} * * *`;
}

function dreamReportCron(): string {
  const minute = ((DREAM_REPORT_OFFSET_MIN % 60) + 60) % 60;
  const hour = (DREAM_HOUR + Math.floor(DREAM_REPORT_OFFSET_MIN / 60)) % 24;
  return `${minute} ${hour} * * *`;
}

const DREAM_REPORT_PROMPT =
  '[DREAM REPORT — handled by orchestrator, not the agent]';

export function registerDreamHandlers(
  agents: Record<string, RegisteredAgent>,
): void {
  const existingHandlers = getAllHandlers();
  const existingDreamHandlers = new Map(
    existingHandlers
      .filter((h) => h.id.startsWith(DREAM_HANDLER_PREFIX))
      .map((h) => [h.id, h]),
  );

  // One dream handler per folder. Always include the main folder; non-main
  // folders are derived from registered agents.
  const allFolders = new Set<string>([MAIN_AGENT_FOLDER]);
  for (const a of Object.values(agents)) allFolders.add(a.folder);

  const seenHandlerIds = new Set<string>();
  const cron = dreamCron();

  for (const folder of allFolders) {
    const handlerId = `${DREAM_HANDLER_PREFIX}${folder}`;
    seenHandlerIds.add(handlerId);

    const existing = existingDreamHandlers.get(handlerId);

    if (!DREAM_ENABLED) {
      if (existing && existing.status === 'active') {
        updateHandler(handlerId, { status: 'paused' });
        logger.info(
          { handlerId },
          'Dream handler paused (DREAM_ENABLED=false)',
        );
      }
      continue;
    }

    if (existing) {
      if (existing.cron !== cron) {
        deleteHandler(handlerId);
        logger.info(
          { handlerId, oldCron: existing.cron, newCron: cron },
          'Dream handler recreated',
        );
      } else {
        const updates: Parameters<typeof updateHandler>[1] = {};
        if (existing.status !== 'active') updates.status = 'active';
        if (Object.keys(updates).length > 0) {
          updateHandler(handlerId, updates);
          logger.info({ handlerId }, 'Dream handler updated');
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
      group_folder: folder,
      prompt: DREAM_PROMPT,
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
    logger.info({ handlerId, folder, cron, nextRun }, 'Dream handler created');
  }

  // Pause dream handlers for folders that no longer exist
  for (const [handlerId, handler] of existingDreamHandlers) {
    if (
      handlerId !== DREAM_REPORT_HANDLER_ID &&
      !seenHandlerIds.has(handlerId) &&
      handler.status === 'active'
    ) {
      updateHandler(handlerId, { status: 'paused' });
      logger.info({ handlerId }, 'Dream handler paused (folder removed)');
    }
  }

  registerDreamReportHandler(
    existingDreamHandlers.get(DREAM_REPORT_HANDLER_ID),
  );
}

function registerDreamReportHandler(existing: Handler | undefined): void {
  const cron = dreamReportCron();

  if (!DREAM_ENABLED) {
    if (existing && existing.status === 'active') {
      updateHandler(DREAM_REPORT_HANDLER_ID, { status: 'paused' });
      logger.info(
        { handlerId: DREAM_REPORT_HANDLER_ID },
        'Dream report handler paused (DREAM_ENABLED=false)',
      );
    }
    return;
  }

  if (existing) {
    if (existing.cron !== cron) {
      deleteHandler(DREAM_REPORT_HANDLER_ID);
      logger.info(
        {
          handlerId: DREAM_REPORT_HANDLER_ID,
          oldCron: existing.cron,
          newCron: cron,
        },
        'Dream report handler recreated',
      );
    } else {
      const updates: Parameters<typeof updateHandler>[1] = {};
      if (existing.status !== 'active') updates.status = 'active';
      if (Object.keys(updates).length > 0) {
        updateHandler(DREAM_REPORT_HANDLER_ID, updates);
        logger.info(
          { handlerId: DREAM_REPORT_HANDLER_ID },
          'Dream report handler updated',
        );
      }
      return;
    }
  }

  const nextRun = CronExpressionParser.parse(cron, { tz: TIMEZONE })
    .next()
    .toISOString();
  const filter = JSON.stringify({ handler_id: DREAM_REPORT_HANDLER_ID });

  createHandler({
    id: DREAM_REPORT_HANDLER_ID,
    group_folder: MAIN_AGENT_FOLDER,
    prompt: DREAM_REPORT_PROMPT,
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
    { handlerId: DREAM_REPORT_HANDLER_ID, cron, nextRun },
    'Dream report handler created',
  );
}
