import { CronExpressionParser } from 'cron-parser';

import { SCHEDULER_POLL_INTERVAL, TIMEZONE } from '../config.js';
import {
  emitEvent,
  getCronDueHandlers,
  getHandlerById,
  updateHandlerNextRun,
} from '../db.js';
import { logger } from '../logger.js';

let schedulerRunning = false;

export function startSchedulerEmitter(): void {
  if (schedulerRunning) {
    logger.debug('Scheduler emitter already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler emitter started');

  const loop = async () => {
    try {
      const dueHandlers = getCronDueHandlers();
      if (dueHandlers.length > 0) {
        logger.info({ count: dueHandlers.length }, 'Found due handlers');
      }

      for (const handler of dueHandlers) {
        // Re-check status in case it was paused/cancelled
        const current = getHandlerById(handler.id);
        if (!current || current.status !== 'active') {
          continue;
        }

        // Emit cron_trigger event for this handler
        emitEvent('cron_trigger', { handler_id: handler.id });

        // Compute next_run from cron expression
        let nextRun: string | null = null;
        if (handler.cron) {
          try {
            const interval = CronExpressionParser.parse(handler.cron, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch (err) {
            logger.error(
              { handlerId: handler.id, cron: handler.cron, err },
              'Invalid cron expression',
            );
          }
        }
        // If no cron (one-shot), next_run stays null → won't fire again

        updateHandlerNextRun(handler.id, nextRun);
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler emitter');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
