import { EVENT_POLL_INTERVAL } from '../config.js';
import { logger } from '../logger.js';
import { ensureBuiltinWorkflows } from './builtins.js';
import { recover, tick } from './engine.js';
import { migrateHandlersToWorkflows } from './migrate.js';
import { syncWorkflowFiles, watchWorkflowFiles } from './store.js';
import {
  checkMissedRuns,
  dispatchEvents,
  scanDueTriggers,
} from './triggers.js';

let running = false;

// One coarse loop drives everything: event triggers, due cron and one-shot
// rows, then the engine's own timers and event waits.
async function pass(): Promise<void> {
  await dispatchEvents();
  await scanDueTriggers();
  await tick();
  await checkMissedRuns();
}

export async function startWorkflowService(): Promise<void> {
  if (running) return;
  running = true;

  ensureBuiltinWorkflows();
  migrateHandlersToWorkflows();
  syncWorkflowFiles();
  watchWorkflowFiles();

  await recover();

  const loop = async () => {
    try {
      await pass();
    } catch (err) {
      logger.error({ err }, 'workflow: service pass failed');
    }
    setTimeout(loop, EVENT_POLL_INTERVAL);
  };
  void loop();
  logger.info('Workflow service started');
}
