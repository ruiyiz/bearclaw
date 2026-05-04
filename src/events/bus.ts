import fs from 'fs';
import path from 'path';

import {
  EVENT_POLL_INTERVAL,
  AGENTS_DIR,
  MAIN_AGENT_FOLDER,
  HEARTBEAT_HANDLER_PREFIX,
  DREAM_HANDLER_PREFIX,
} from '../config.js';
import { dispatchDreamHandler } from '../dream/orchestrator.js';
import {
  cleanupProcessedEvents,
  emitEvent,
  getAllHandlers,
  getMatchingHandlers,
  getUnprocessedEvents,
  logHandlerRun,
  markEventProcessed,
  updateHandlerAfterTrigger,
} from '../db.js';
import { runContainerAgent, writeHandlersSnapshot } from '../agent/runner.js';
import { logger } from '../logger.js';
import { isInQuietPeriod } from '../utils/time.js';
import { EventRecord, Handler, RegisteredAgent } from '../types.js';

interface EventBusDependencies {
  registeredAgents: () => Record<string, RegisteredAgent>;
  getSessions: () => Record<string, string>;
  saveSessions: () => void;
}

async function runHandler(
  handler: Handler,
  event: EventRecord,
  deps: EventBusDependencies,
): Promise<void> {
  const startTime = Date.now();
  const agentDir = path.join(AGENTS_DIR, handler.group_folder);
  fs.mkdirSync(agentDir, { recursive: true });

  // Dream handlers bypass the standard agent runner — they invoke the dream
  // orchestrator, which handles its own session reset and subagent runs.
  if (handler.id.startsWith(DREAM_HANDLER_PREFIX)) {
    let error: string | null = null;
    try {
      await dispatchDreamHandler(handler.group_folder, {
        registeredAgents: deps.registeredAgents,
        getSessions: deps.getSessions,
        saveSessions: deps.saveSessions,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.error({ handlerId: handler.id, error }, 'Dream handler failed');
    }
    const durationMs = Date.now() - startTime;
    logHandlerRun({
      handler_id: handler.id,
      event_id: event.id,
      run_at: new Date().toISOString(),
      duration_ms: durationMs,
      status: error ? 'error' : 'success',
      result: error ? null : 'Dream cycle completed',
      error,
    });
    updateHandlerAfterTrigger(handler.id);
    emitEvent('handler_complete', {
      handler_id: handler.id,
      group_folder: handler.group_folder,
      status: error ? 'error' : 'success',
      result_summary: error ? `Error: ${error}` : 'Dream cycle completed',
    });
    return;
  }

  const agents = deps.registeredAgents();
  const agent = Object.values(agents).find(
    (g) => g.folder === handler.group_folder,
  );

  if (!agent) {
    logger.error(
      { handlerId: handler.id, agentFolder: handler.group_folder },
      'Agent not found for handler',
    );
    logHandlerRun({
      handler_id: handler.id,
      event_id: event.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Agent not found: ${handler.group_folder}`,
    });
    return;
  }

  // Skip Heartbeat handlers during quiet period
  if (
    handler.id.startsWith(HEARTBEAT_HANDLER_PREFIX) &&
    agent.heartbeat?.quiet &&
    isInQuietPeriod(agent.heartbeat.quiet)
  ) {
    logger.debug(
      { handlerId: handler.id },
      'Heartbeat handler skipped (quiet period)',
    );
    return;
  }

  const isMain = handler.group_folder === MAIN_AGENT_FOLDER;
  // No originating channel for event handlers; IPC processing will
  // fan out to all channels registered to the group folder.
  const chatJid = '';

  // Write handlers snapshot for the agent
  const handlers = getAllHandlers();
  writeHandlersSnapshot(handler.group_folder, isMain, handlers);

  // Build event-handler prompt
  const prompt = `[EVENT TRIGGERED - You are running automatically in response to an internal event.
 Use mcp__nanoclaw__send_message to communicate with the user.
 Use mcp__nanoclaw__emit_event to chain to the next step.]

<event type="${event.type}" emitted_at="${event.emitted_at}">
${event.payload}
</event>

<handler_instructions>
${handler.prompt}
</handler_instructions>`;

  // Determine session key: use payload's session_key if present, else fall back to group folder
  let payloadObj: Record<string, unknown>;
  try {
    payloadObj = JSON.parse(event.payload);
  } catch {
    payloadObj = {};
  }
  const sessionKey =
    handler.context_mode === 'agent'
      ? (payloadObj.session_key as string) || handler.group_folder
      : '';

  const sessions = deps.getSessions();
  const sessionId =
    handler.context_mode === 'agent' ? sessions[sessionKey] : undefined;

  let result: string | null = null;
  let error: string | null = null;

  try {
    // Pass model override for Heartbeat handlers
    const model = handler.id.startsWith(HEARTBEAT_HANDLER_PREFIX)
      ? agent.heartbeat?.model
      : undefined;

    const output = await runContainerAgent(agent, {
      prompt,
      sessionId,
      agentFolder: handler.group_folder,
      chatJid,
      isMain,
      isEventHandler: true,
      model,
    });

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else {
      result = output.result;
    }

    // Persist new session ID for group-mode handlers
    if (output.newSessionId && handler.context_mode === 'agent') {
      sessions[sessionKey] = output.newSessionId;
      deps.saveSessions();
    }

    logger.info(
      {
        handlerId: handler.id,
        eventType: event.type,
        durationMs: Date.now() - startTime,
      },
      'Handler completed',
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error(
      { handlerId: handler.id, eventType: event.type, error },
      'Handler failed',
    );
  }

  const durationMs = Date.now() - startTime;

  logHandlerRun({
    handler_id: handler.id,
    event_id: event.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result: result ? result.slice(0, 500) : null,
    error,
  });

  updateHandlerAfterTrigger(handler.id);

  // Emit handler_complete for chaining
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  emitEvent('handler_complete', {
    handler_id: handler.id,
    group_folder: handler.group_folder,
    status: error ? 'error' : 'success',
    result_summary: resultSummary,
  });
}

let busRunning = false;
let cleanupCounter = 0;

export function startEventBusLoop(deps: EventBusDependencies): void {
  if (busRunning) {
    logger.debug('Event bus loop already running, skipping duplicate start');
    return;
  }
  busRunning = true;
  logger.info('Event bus loop started');

  const loop = async () => {
    try {
      const events = getUnprocessedEvents();

      for (const event of events) {
        try {
          const handlers = getMatchingHandlers(event);
          for (const handler of handlers) {
            await runHandler(handler, event, deps);
          }
        } catch (err) {
          logger.error(
            { eventId: event.id, eventType: event.type, err },
            'Error processing event',
          );
        }

        markEventProcessed(event.id);
      }

      // Periodic cleanup (every ~5 minutes = 60 iterations at 5s)
      cleanupCounter++;
      if (cleanupCounter >= 60) {
        cleanupCounter = 0;
        cleanupProcessedEvents();
      }
    } catch (err) {
      logger.error({ err }, 'Error in event bus loop');
    }

    setTimeout(loop, EVENT_POLL_INTERVAL);
  };

  loop();
}
