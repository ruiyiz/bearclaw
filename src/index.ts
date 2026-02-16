import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DISPLAY_NAME,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  SESSION_IDLE_MINUTES,
  SESSION_RESET_HOUR,
  TELEGRAM_BOT_POOL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ONLY,
  TIMEZONE,
} from './config.js';
import {
  AvailableGroup,
  runContainerAgent,
  writeGroupsSnapshot,
  writeHandlersSnapshot,
} from './agent-runner.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { initBotPool, TelegramChannel } from './channels/telegram.js';
import { guessMimetype, resolveMediaSource } from './media.js';
import {
  createHandler,
  deleteHandler,
  emitEvent,
  getAllChats,
  getAllHandlers,
  getHandlerById,
  getMessagesSince,
  getNewMessages,
  initDatabase,
  storeChatMetadata,
  storeMessage,
  updateHandler,
} from './db.js';
import { registerEmailHandlers, sendEmailReply, startEmailLoops } from './email-channel.js';
import { startEventBusLoop } from './event-bus.js';
import { registerOdysseyHandlers } from './odyssey.js';
import { findChannel } from './router.js';
import { startSchedulerEmitter } from './task-scheduler.js';
import { Channel, MediaType, NewMessage, RegisteredGroup, Session } from './types.js';
import { loadJson, saveJson } from './utils.js';
import { logger } from './logger.js';

let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let sessionLastActivity: Record<string, string> = {};
let lastDailyReset = '';
let messageLoopRunning = false;
let ipcWatcherRunning = false;

const channels: Channel[] = [];

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
    session_last_activity?: Record<string, string>;
    last_daily_reset?: string;
  }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessionLastActivity = state.session_last_activity || {};
  lastDailyReset = state.last_daily_reset || '';
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(
    path.join(DATA_DIR, 'registered_groups.json'),
    {},
  );
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), {
    last_timestamp: lastTimestamp,
    last_agent_timestamp: lastAgentTimestamp,
    session_last_activity: sessionLastActivity,
    last_daily_reset: lastDailyReset,
  });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && (c.jid.endsWith('@g.us') || c.jid.startsWith('tg:')))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

async function processMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_jid];
  if (!group) return;

  let content = msg.content.trim();
  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  if (!isMainGroup) {
    if (group.trigger) {
      const triggerPattern = new RegExp(`^${group.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (!triggerPattern.test(content)) return;
    }
  }

  if (content === '/new' || content.toLowerCase().startsWith('/new ')) {
    delete sessions[group.folder];
    saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    logger.info({ group: group.name }, 'Session cleared by user');

    const followUp = content.slice(4).trim();
    if (!followUp) {
      const ch = findChannel(channels, msg.chat_jid);
      if (ch) {
        await ch.sendMessage(msg.chat_jid, 'Session cleared! Starting fresh.');
      }
      lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
      saveState();
      return;
    }
    content = followUp;
  }

  const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || '';
  const botPrefixes = DISPLAY_NAME !== ASSISTANT_NAME
    ? [DISPLAY_NAME, ASSISTANT_NAME]
    : [ASSISTANT_NAME];
  const missedMessages = getMessagesSince(
    msg.chat_jid,
    sinceTimestamp,
    botPrefixes,
  );

  const lines = missedMessages.map((m) => {
    const escapeXml = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  if (!prompt) return;

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing message',
  );

  const channel = findChannel(channels, msg.chat_jid);
  if (channel) await channel.setTyping?.(msg.chat_jid, true);
  const response = await runAgent(group, prompt, msg.chat_jid);
  if (channel) await channel.setTyping?.(msg.chat_jid, false);

  if (response && !isNonResponse(response) && channel) {
    lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
    await channel.sendMessage(msg.chat_jid, response);
  }
}

function isNonResponse(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.\s]+$/g, '');
  const suppressPatterns = [
    'no response requested',
    'no response needed',
    'no response necessary',
    'no response required',
  ];
  return suppressPatterns.includes(normalized);
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
): Promise<string | null> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  const handlers = getAllHandlers();
  writeHandlersSnapshot(group.folder, isMain, handlers);

  try {
    const output = await runContainerAgent(group, {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain,
    });

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    sessionLastActivity[group.folder] = new Date().toISOString();

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return null;
    }

    return output.result;
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return null;
  }
}

function startIpcWatcher(): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && (data.text || data.mediaType)) {
                let targetJid: string | undefined;
                if (data.targetFolder && isMain) {
                  targetJid = Object.entries(registeredGroups).find(
                    ([, g]) => g.folder === data.targetFolder,
                  )?.[0];
                  if (!targetJid) {
                    logger.warn(
                      { targetFolder: data.targetFolder, sourceGroup },
                      'Target group folder not found for message routing',
                    );
                  }
                }
                if (!targetJid) targetJid = data.chatJid;

                if (targetJid) {
                  const targetGroup = registeredGroups[targetJid];
                  if (
                    isMain ||
                    (targetGroup && targetGroup.folder === sourceGroup)
                  ) {
                    const ipcChannel = findChannel(channels, targetJid);
                    if (data.mediaType) {
                      const mediaSource = resolveMediaSource(data.filePath, data.mediaUrl, sourceGroup);
                      if (mediaSource && ipcChannel?.sendMedia) {
                        const caption = data.text || undefined;
                        const mediaType = data.mediaType as MediaType;
                        const fileName = data.fileName || (data.filePath ? path.basename(data.filePath) : undefined);
                        const mimetype = data.mimetype || guessMimetype(data.filePath || data.mediaUrl || '');

                        if (data.sender && ipcChannel.sendMediaAsAgent) {
                          await ipcChannel.sendMediaAsAgent(targetJid, mediaType, mediaSource, { caption, fileName, mimetype }, data.sender, sourceGroup);
                        } else {
                          await ipcChannel.sendMedia(targetJid, mediaType, mediaSource, { caption, fileName, mimetype });
                        }
                      } else if (!mediaSource) {
                        logger.error({ targetJid, sourceGroup }, 'Could not resolve media source');
                      } else {
                        logger.warn({ targetJid, channel: ipcChannel?.name }, 'Channel does not support media');
                      }
                    } else if (data.sender && ipcChannel?.sendAsAgent) {
                      await ipcChannel.sendAsAgent(targetJid, data.text, data.sender, sourceGroup);
                    } else if (ipcChannel) {
                      await ipcChannel.sendMessage(targetJid, data.text);
                    }
                    logger.info(
                      {
                        targetJid,
                        sourceGroup,
                        mediaType: data.mediaType || 'text',
                      },
                      'IPC message sent',
                    );
                  } else {
                    logger.warn(
                      { targetJid, sourceGroup },
                      'Unauthorized IPC message attempt blocked',
                    );
                  }
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              await processTaskIpc(data, sourceGroup, isMain);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

async function processTaskIpc(
  data: {
    type: string;
    prompt?: string;
    cron?: string | null;
    runAt?: string | null;
    context_mode?: string;
    groupFolder?: string;
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requestId?: string;
    messageId?: string;
    to?: string;
    subject?: string;
    body?: string;
    eventType?: string;
    payload?: Record<string, unknown>;
    handlerId?: string;
    filter?: string | null;
    contextMode?: string;
    cooldownMs?: number;
    maxTriggers?: number | null;
    targetGroup?: string;
  },
  sourceGroup: string,
  isMain: boolean,
): Promise<void> {
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task':
      if (data.prompt && data.groupFolder) {
        const targetGroup = data.groupFolder;
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetGroup },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const handlerId = `handler-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';

        let cron: string | null = data.cron || null;
        let nextRun: string | null = null;
        let maxTriggers: number | null = null;

        if (cron) {
          try {
            const interval = CronExpressionParser.parse(cron, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn({ cron }, 'Invalid cron expression');
            break;
          }
        } else if (data.runAt) {
          const scheduled = new Date(data.runAt);
          if (isNaN(scheduled.getTime())) {
            logger.warn({ runAt: data.runAt }, 'Invalid timestamp');
            break;
          }
          nextRun = scheduled.toISOString();
          maxTriggers = 1;
        } else {
          logger.warn('schedule_task requires cron or runAt');
          break;
        }

        const filter = JSON.stringify({ handler_id: handlerId });
        createHandler({
          id: handlerId,
          group_folder: targetGroup,
          prompt: data.prompt,
          context_mode: contextMode,
          event_type: 'cron_trigger',
          filter,
          cron,
          next_run: nextRun,
          cooldown_ms: 0,
          max_triggers: maxTriggers,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { handlerId, sourceGroup, targetGroup, contextMode, cron },
          'Scheduled handler created via IPC',
        );
      }
      break;

    case 'refresh_groups':
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        for (const ch of channels) {
          await ch.syncMetadata?.(true);
        }
        const availableGroups = getAvailableGroups();
        writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'emit_event':
      if (data.eventType) {
        emitEvent(data.eventType, data.payload || {});
        logger.info(
          { eventType: data.eventType, sourceGroup },
          'Event emitted via IPC',
        );
      }
      break;

    case 'register_handler':
      if (data.eventType && data.prompt) {
        const handlerTarget = data.targetGroup || sourceGroup;
        if (!isMain && handlerTarget !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetGroup: handlerTarget },
            'Unauthorized register_handler attempt blocked',
          );
          break;
        }

        const handlerId = `handler-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const handlerContextMode =
          data.contextMode === 'group' || data.contextMode === 'isolated'
            ? data.contextMode
            : 'isolated';
        createHandler({
          id: handlerId,
          event_type: data.eventType,
          filter: data.filter ?? null,
          group_folder: handlerTarget,
          prompt: data.prompt,
          context_mode: handlerContextMode,
          cron: null,
          next_run: null,
          cooldown_ms: data.cooldownMs || 0,
          max_triggers: data.maxTriggers ?? null,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { handlerId, eventType: data.eventType, sourceGroup, targetGroup: handlerTarget },
          'Handler registered via IPC',
        );
      }
      break;

    case 'pause_handler':
      if (data.handlerId) {
        const handler = getHandlerById(data.handlerId);
        if (handler && (isMain || handler.group_folder === sourceGroup)) {
          updateHandler(data.handlerId, { status: 'paused' });
          logger.info(
            { handlerId: data.handlerId, sourceGroup },
            'Handler paused via IPC',
          );
        } else {
          logger.warn(
            { handlerId: data.handlerId, sourceGroup },
            'Unauthorized handler pause attempt',
          );
        }
      }
      break;

    case 'resume_handler':
      if (data.handlerId) {
        const handler = getHandlerById(data.handlerId);
        if (handler && (isMain || handler.group_folder === sourceGroup)) {
          updateHandler(data.handlerId, { status: 'active' });
          logger.info(
            { handlerId: data.handlerId, sourceGroup },
            'Handler resumed via IPC',
          );
        } else {
          logger.warn(
            { handlerId: data.handlerId, sourceGroup },
            'Unauthorized handler resume attempt',
          );
        }
      }
      break;

    case 'cancel_handler':
      if (data.handlerId) {
        const handler = getHandlerById(data.handlerId);
        if (handler && (isMain || handler.group_folder === sourceGroup)) {
          deleteHandler(data.handlerId);
          logger.info(
            { handlerId: data.handlerId, sourceGroup },
            'Handler cancelled via IPC',
          );
        } else {
          logger.warn(
            { handlerId: data.handlerId, sourceGroup },
            'Unauthorized handler cancel attempt',
          );
        }
      }
      break;

    case 'register_group':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'reply_email':
      if (data.requestId && data.messageId && data.to && data.subject && data.body) {
        const emailResultsDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'email_results');
        fs.mkdirSync(emailResultsDir, { recursive: true });
        try {
          await sendEmailReply(data.messageId, data.to, data.subject, data.body);
          const resultFile = path.join(emailResultsDir, `${data.requestId}.json`);
          fs.writeFileSync(resultFile, JSON.stringify({ success: true, message: 'Email reply sent' }));
          logger.info({ messageId: data.messageId, to: data.to, sourceGroup }, 'Email reply sent via IPC');
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const resultFile = path.join(emailResultsDir, `${data.requestId}.json`);
          fs.writeFileSync(resultFile, JSON.stringify({ success: false, message: `Failed to send email: ${errorMsg}` }));
          logger.error({ messageId: data.messageId, err, sourceGroup }, 'Failed to send email reply via IPC');
        }
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

function checkSessionResets(): void {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  let changed = false;

  // Daily reset at configured hour
  if (SESSION_RESET_HOUR >= 0 && SESSION_RESET_HOUR <= 23) {
    if (now.getHours() === SESSION_RESET_HOUR && lastDailyReset !== today) {
      const folders = Object.keys(sessions);
      if (folders.length > 0) {
        for (const folder of folders) {
          delete sessions[folder];
          delete sessionLastActivity[folder];
        }
        lastDailyReset = today;
        changed = true;
        logger.info(
          { hour: SESSION_RESET_HOUR, cleared: folders },
          'Daily session reset',
        );
      } else {
        lastDailyReset = today;
      }
    }
  }

  // Idle reset per session
  if (SESSION_IDLE_MINUTES > 0) {
    const cutoff = now.getTime() - SESSION_IDLE_MINUTES * 60 * 1000;
    for (const folder of Object.keys(sessions)) {
      const lastActive = sessionLastActivity[folder];
      if (lastActive && new Date(lastActive).getTime() < cutoff) {
        delete sessions[folder];
        delete sessionLastActivity[folder];
        changed = true;
        logger.info(
          { folder, idleMinutes: SESSION_IDLE_MINUTES },
          'Idle session reset',
        );
      }
    }
  }

  if (changed) {
    saveState();
  }
}

function startSessionResetLoop(): void {
  if (SESSION_RESET_HOUR < 0 && SESSION_IDLE_MINUTES <= 0) {
    logger.debug('Session reset disabled');
    return;
  }

  setInterval(checkSessionResets, 60_000);
  logger.info(
    { resetHour: SESSION_RESET_HOUR, idleMinutes: SESSION_IDLE_MINUTES },
    'Session reset loop started',
  );
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;
  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const botPrefixes = DISPLAY_NAME !== ASSISTANT_NAME
        ? [DISPLAY_NAME, ASSISTANT_NAME]
        : [ASSISTANT_NAME];
      const { messages } = getNewMessages(jids, lastTimestamp, botPrefixes);

      if (messages.length > 0)
        logger.info({ count: messages.length }, 'New messages');
      for (const msg of messages) {
        try {
          await processMessage(msg);
          lastTimestamp = msg.timestamp;
          saveState();
        } catch (err) {
          logger.error(
            { err, msg: msg.id },
            'Error processing message, will retry',
          );
          break;
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');
  loadState();

  registerOdysseyHandlers(registeredGroups);
  registerEmailHandlers(registeredGroups);

  // Initialize channels based on config
  if (!TELEGRAM_ONLY) {
    const whatsapp = new WhatsAppChannel({
      onMessage: (_chatJid, msg) => storeMessage(msg),
      onChatMetadata: (chatJid, ts, name) => storeChatMetadata(chatJid, ts, name),
      registeredGroups: () => registeredGroups,
    });
    channels.push(whatsapp);
    whatsapp.connect(); // fire-and-forget, internal reconnection
  }

  if (TELEGRAM_BOT_TOKEN) {
    const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, {
      onMessage: (_chatJid, msg) => storeMessage(msg),
      onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
      registeredGroups: () => registeredGroups,
    });
    channels.push(telegram);
    await telegram.connect();
    if (TELEGRAM_BOT_POOL.length > 0) {
      await initBotPool(TELEGRAM_BOT_POOL);
    }
  }

  // Start all subsystems unconditionally
  startSessionResetLoop();
  startSchedulerEmitter();
  startEventBusLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    saveSessions: () => saveJson(path.join(DATA_DIR, 'sessions.json'), sessions),
  });
  startIpcWatcher();
  startMessageLoop();
  startEmailLoops(registeredGroups);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
