import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import makeWASocket, {
  DisconnectReason,
  WASocket,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DISPLAY_NAME,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  STORE_DIR,
  TELEGRAM_BOT_POOL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ONLY,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import {
  AvailableGroup,
  runContainerAgent,
  writeGroupsSnapshot,
  writeHandlersSnapshot,
} from './agent-runner.js';
import { initBotPool, sendPoolMessage, TelegramChannel } from './channels/telegram.js';
import {
  createHandler,
  deleteHandler,
  emitEvent,
  getAllChats,
  getAllHandlers,
  getHandlerById,
  getLastGroupSync,
  getMessagesSince,
  getNewMessages,
  initDatabase,
  setLastGroupSync,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
  updateChatName,
  updateHandler,
} from './db.js';
import { registerEmailHandlers, sendEmailReply, startEmailLoops } from './email-channel.js';
import { startEventBusLoop } from './event-bus.js';
import { registerOdysseyHandlers } from './odyssey.js';
import { findChannel, formatOutbound } from './router.js';
import { startSchedulerEmitter } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup, Session } from './types.js';
import { loadJson, saveJson } from './utils.js';
import { logger } from './logger.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let sock: WASocket;
let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
// LID to phone number mapping (WhatsApp now sends LID JIDs for self-chats)
let lidToPhoneMap: Record<string, string> = {};
// Guards to prevent duplicate loops on WhatsApp reconnect
let messageLoopRunning = false;
let ipcWatcherRunning = false;
let groupSyncTimerStarted = false;

const channels: Channel[] = [];

/**
 * Translate a JID from LID format to phone format if we have a mapping.
 * Returns the original JID if no mapping exists.
 */
function translateJid(jid: string): string {
  if (!jid.endsWith('@lid')) return jid;
  const lidUser = jid.split('@')[0].split(':')[0];
  const phoneJid = lidToPhoneMap[lidUser];
  if (phoneJid) {
    logger.debug({ lidJid: jid, phoneJid }, 'Translated LID to phone JID');
    return phoneJid;
  }
  return jid;
}

async function setTyping(jid: string, isTyping: boolean): Promise<void> {
  try {
    await sock.sendPresenceUpdate(isTyping ? 'composing' : 'paused', jid);
  } catch (err) {
    logger.debug({ jid, err }, 'Failed to update typing status');
  }
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
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
  });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  // Create group folder
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Sync group metadata from WhatsApp.
 * Fetches all participating groups and stores their names in the database.
 * Called on startup, daily, and on-demand via IPC.
 */
async function syncGroupMetadata(force = false): Promise<void> {
  // Check if we need to sync (skip if synced recently, unless forced)
  if (!force) {
    const lastSync = getLastGroupSync();
    if (lastSync) {
      const lastSyncTime = new Date(lastSync).getTime();
      const now = Date.now();
      if (now - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
        logger.debug({ lastSync }, 'Skipping group sync - synced recently');
        return;
      }
    }
  }

  try {
    logger.info('Syncing group metadata from WhatsApp...');
    const groups = await sock.groupFetchAllParticipating();

    let count = 0;
    for (const [jid, metadata] of Object.entries(groups)) {
      if (metadata.subject) {
        updateChatName(jid, metadata.subject);
        count++;
      }
    }

    setLastGroupSync();
    logger.info({ count }, 'Group metadata synced');
  } catch (err) {
    logger.error({ err }, 'Failed to sync group metadata');
  }
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
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

  // Main group responds to all messages; other groups check per-group trigger
  if (!isMainGroup) {
    if (group.trigger) {
      // Group has a trigger - check if message starts with it
      const triggerPattern = new RegExp(`^${group.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (!triggerPattern.test(content)) return;
    }
    // Empty trigger means respond to all messages in that group
  }

  // Handle /new command - clear session and start fresh
  if (content === '/new' || content.toLowerCase().startsWith('/new ')) {
    delete sessions[group.folder];
    saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    logger.info({ group: group.name }, 'Session cleared by user');

    // If just "/new" with no follow-up, send confirmation and return
    const followUp = content.slice(4).trim();
    if (!followUp) {
      await sendMessage(msg.chat_jid, `${DISPLAY_NAME}: Session cleared! Starting fresh. 🧹`);
      lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
      saveState();
      return;
    }
    // Otherwise, continue processing with the follow-up text as a new session
    content = followUp;
  }

  // Get all messages since last agent interaction so the session has full context
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
    // Escape XML special characters in content
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

  if (response && !isNonResponse(response)) {
    lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
    if (channel) {
      const text = formatOutbound(channel, response);
      await channel.sendMessage(msg.chat_jid, text);
    } else {
      await sendMessage(msg.chat_jid, `${DISPLAY_NAME}: ${response.trimStart()}`);
    }
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

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Update handlers snapshot
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

async function sendMessage(jid: string, text: string): Promise<void> {
  try {
    await sock.sendMessage(jid, { text });
    logger.info({ jid, length: text.length }, 'Message sent');
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send message');
  }
}

function guessMimetype(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx':
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx':
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.csv': 'text/csv',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

async function sendMedia(
  jid: string,
  mediaType: 'image' | 'document',
  source: { filePath?: string | null; mediaUrl?: string | null },
  options: {
    caption?: string;
    fileName?: string | null;
    mimetype?: string | null;
  },
  sourceGroup: string,
): Promise<void> {
  try {
    let media: Buffer | { url: string };

    if (source.mediaUrl) {
      media = { url: source.mediaUrl };
    } else if (source.filePath) {
      const resolvedPath = path.isAbsolute(source.filePath)
        ? source.filePath
        : path.join(GROUPS_DIR, sourceGroup, source.filePath);

      if (!fs.existsSync(resolvedPath)) {
        logger.error(
          { resolvedPath, sourceGroup },
          'Media file not found',
        );
        return;
      }
      media = fs.readFileSync(resolvedPath);
    } else {
      logger.error('No media source provided');
      return;
    }

    const caption = options.caption || undefined;

    if (mediaType === 'image') {
      await sock.sendMessage(jid, { image: media, caption });
    } else if (mediaType === 'document') {
      const mimetype =
        options.mimetype ||
        guessMimetype(source.filePath || source.mediaUrl || '');
      const fileName =
        options.fileName ||
        path.basename(source.filePath || source.mediaUrl || 'file');
      await sock.sendMessage(jid, {
        document: media,
        mimetype,
        fileName,
        caption,
      });
    }

    logger.info({ jid, mediaType }, 'Media message sent');
  } catch (err) {
    logger.error({ jid, mediaType, err }, 'Failed to send media message');
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
    // Scan all group IPC directories (identity determined by directory)
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

      // Process messages from this group's IPC directory
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
                // Resolve target: use targetFolder if specified (main only), else use chatJid
                let targetJid: string | undefined;
                if (data.targetFolder && isMain) {
                  // Find JID for the target folder
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
                // Fall back to chatJid if no targetFolder or not main
                if (!targetJid) targetJid = data.chatJid;

                if (targetJid) {
                  // Authorization: verify this group can send to this JID
                  const targetGroup = registeredGroups[targetJid];
                  if (
                    isMain ||
                    (targetGroup && targetGroup.folder === sourceGroup)
                  ) {
                    const ipcChannel = findChannel(channels, targetJid);
                    if (data.sender && targetJid.startsWith('tg:')) {
                      // Swarm message — route through pool bot
                      await sendPoolMessage(
                        targetJid,
                        data.text,
                        data.sender,
                        sourceGroup,
                      );
                    } else if (data.mediaType) {
                      // Media message (image or document) — WhatsApp only for now
                      await sendMedia(
                        targetJid,
                        data.mediaType,
                        {
                          filePath: data.filePath,
                          mediaUrl: data.mediaUrl,
                        },
                        {
                          caption: data.text
                            ? `${DISPLAY_NAME}: ${data.text.trimStart()}`
                            : undefined,
                          fileName: data.fileName,
                          mimetype: data.mimetype,
                        },
                        sourceGroup,
                      );
                    } else if (ipcChannel) {
                      const ipcText = formatOutbound(ipcChannel, data.text);
                      await ipcChannel.sendMessage(targetJid, ipcText);
                    } else {
                      await sendMessage(
                        targetJid,
                        `${DISPLAY_NAME}: ${data.text.trimStart()}`,
                      );
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

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
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
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    // For reply_email
    requestId?: string;
    messageId?: string;
    to?: string;
    subject?: string;
    body?: string;
    // For event handlers
    eventType?: string;
    payload?: Record<string, unknown>;
    handlerId?: string;
    filter?: string | null;
    contextMode?: string;
    cooldownMs?: number;
    maxTriggers?: number | null;
    targetGroup?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
): Promise<void> {
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task':
      if (data.prompt && data.groupFolder) {
        // Authorization: non-main groups can only schedule for themselves
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
          maxTriggers = 1; // One-shot
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
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = getAvailableGroups();
        const { writeGroupsSnapshot: writeGroups } =
          await import('./agent-runner.js');
        writeGroups(
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
        // Authorization: non-main groups can only register handlers for themselves
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
      // Only main group can register new groups
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

async function connectWhatsApp(): Promise<void> {
  const authDir = path.join(STORE_DIR, 'auth');
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: ['NanoClaw', 'Chrome', '1.0.0'],
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const msg =
        'WhatsApp authentication required. Run /setup in Claude Code.';
      logger.error(msg);
      exec(
        `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
      );
      setTimeout(() => process.exit(1), 1000);
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      logger.info({ reason, shouldReconnect }, 'Connection closed');

      if (shouldReconnect) {
        logger.info('Reconnecting...');
        connectWhatsApp();
      } else {
        logger.info('Logged out. Run /setup to re-authenticate.');
        process.exit(0);
      }
    } else if (connection === 'open') {
      logger.info('Connected to WhatsApp');
      
      // Build LID to phone mapping from auth state for self-chat translation
      if (sock.user) {
        const phoneUser = sock.user.id.split(':')[0];
        const lidUser = sock.user.lid?.split(':')[0];
        if (lidUser && phoneUser) {
          lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
          logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
        }
      }
      
      // Sync group metadata on startup (respects 24h cache)
      syncGroupMetadata().catch((err) =>
        logger.error({ err }, 'Initial group sync failed'),
      );
      // Set up daily sync timer (only once)
      if (!groupSyncTimerStarted) {
        groupSyncTimerStarted = true;
        setInterval(() => {
          syncGroupMetadata().catch((err) =>
            logger.error({ err }, 'Periodic group sync failed'),
          );
        }, GROUP_SYNC_INTERVAL_MS);
      }
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
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const rawJid = msg.key.remoteJid;
      if (!rawJid || rawJid === 'status@broadcast') continue;

      // Translate LID JID to phone JID if applicable
      const chatJid = translateJid(rawJid);

      const timestamp = new Date(
        Number(msg.messageTimestamp) * 1000,
      ).toISOString();

      // Always store chat metadata for group discovery
      storeChatMetadata(chatJid, timestamp);

      // Only store full message content for registered groups
      if (registeredGroups[chatJid]) {
        // Filter out protocol/system messages (reactions, receipts, etc.)
        const hasUserContent =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage ||
          msg.message?.imageMessage ||
          msg.message?.videoMessage ||
          msg.message?.audioMessage ||
          msg.message?.documentMessage ||
          msg.message?.stickerMessage;

        if (hasUserContent) {
          await storeMessage(
            msg,
            chatJid,
            msg.key.fromMe || false,
            msg.pushName || undefined,
          );
        } else {
          // Log filtered message types for debugging
          const msgTypes = msg.message ? Object.keys(msg.message) : [];
          logger.debug({ msgTypes }, 'Filtered out non-user message');
        }
      }
    }
  });
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
          // Only advance timestamp after successful processing for at-least-once delivery
          lastTimestamp = msg.timestamp;
          saveState();
        } catch (err) {
          logger.error(
            { err, msg: msg.id },
            'Error processing message, will retry',
          );
          // Stop processing this batch - failed message will be retried next loop
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

  // WhatsApp channel adapter (wraps existing sock-based functions)
  if (!TELEGRAM_ONLY) {
    const whatsappAdapter: Channel = {
      name: 'whatsapp',
      prefixAssistantName: true,
      async connect() {},
      async sendMessage(jid, text) { await sendMessage(jid, text); },
      ownsJid(jid) { return !jid.startsWith('tg:'); },
      isConnected() { return !!sock; },
      async disconnect() {},
      async setTyping(jid, isTyping) { await setTyping(jid, isTyping); },
    };
    channels.push(whatsappAdapter);
  }

  // Telegram channel
  if (TELEGRAM_BOT_TOKEN) {
    const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, {
      onMessage: (_chatJid, msg) => storeMessageDirect(msg),
      onChatMetadata: (chatJid, timestamp, name) => storeChatMetadata(chatJid, timestamp, name),
      registeredGroups: () => registeredGroups,
    });
    channels.push(telegram);
    await telegram.connect();
    if (TELEGRAM_BOT_POOL.length > 0) {
      await initBotPool(TELEGRAM_BOT_POOL);
    }
  }

  if (!TELEGRAM_ONLY) {
    await connectWhatsApp();
  } else {
    // Start subsystems without WhatsApp
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
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
