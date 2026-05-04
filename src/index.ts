import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DISPLAY_NAME,
  AGENTS_DIR,
  IPC_POLL_INTERVAL,
  IMESSAGE_ENABLED,
  MAIN_AGENT_FOLDER,
  NANOCLAW_HOME,
  POLL_INTERVAL,
  TELEGRAM_BOT_POOL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ONLY,
  TIMEZONE,
  STT_ECHO_ENABLED,
} from './config.js';
import {
  AvailableGroup,
  runContainerAgent,
  writeAgentsSnapshot,
  writeHandlersSnapshot,
} from './agent/runner.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { initBotPool, TelegramChannel } from './channels/telegram.js';
import { IMessageChannel } from './channels/imessage.js';
import { guessMimetype, resolveMediaSource } from './media/source.js';
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
import {
  registerEmailHandlers,
  sendEmailReply,
  startEmailLoops,
} from './integrations/email.js';
import { startEventBusLoop } from './events/bus.js';
import { registerHeartbeatHandlers } from './events/heartbeat.js';
import { registerDreamHandlers } from './dream/handler.js';
import { embedPendingChunks } from './agent/memory-embed.js';
import {
  isInActiveWindow,
  getNextActiveTime,
  formatNextActiveTime,
} from './utils/time.js';
import { findChannel } from './channels/router.js';
import { startSchedulerEmitter } from './events/scheduler.js';
import { generateSpeech } from './media/tts.js';
import {
  Channel,
  MediaType,
  NewMessage,
  RegisteredAgent,
  Session,
} from './types.js';
import { loadJson, saveJson } from './utils/json.js';
import {
  startMemoryFlusher,
  flushBeforeSessionClear,
  initFlushCursors,
} from './agent/memory-flusher.js';
import { logger } from './logger.js';
import { initSubprocessManager } from './agent/subprocess-manager.js';

let lastTimestamp = '';
let sessions: Session = {};
let registeredAgents: Record<string, RegisteredAgent> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
let ipcWatcherRunning = false;
const folderQueues = new Map<string, Promise<void>>();
const lastAutoReply: Record<string, string> = {}; // chat_jid → ISO timestamp of last off-hours reply

const channels: Channel[] = [];

function migrateToAgents(): void {
  const oldGroupsDir = path.join(NANOCLAW_HOME, 'groups');
  const newAgentsDir = path.join(NANOCLAW_HOME, 'agents');
  const contextDir = path.join(NANOCLAW_HOME, 'context');

  if (fs.existsSync(newAgentsDir) || !fs.existsSync(oldGroupsDir)) return;

  logger.info('Migrating groups/ to agents/ and context/...');

  fs.renameSync(oldGroupsDir, newAgentsDir);

  const globalClaudeMd = path.join(newAgentsDir, 'CLAUDE.md');
  if (fs.existsSync(globalClaudeMd)) {
    const targetAgentsMd = path.join(contextDir, 'AGENTS.md');
    if (!fs.existsSync(targetAgentsMd)) {
      fs.mkdirSync(contextDir, { recursive: true });
      fs.renameSync(globalClaudeMd, targetAgentsMd);
      logger.info(
        'Moved groups/CLAUDE.md to context/AGENTS.md — split into SOUL.md, USER.md, MEMORY.md manually',
      );
    } else {
      fs.unlinkSync(globalClaudeMd);
      logger.info(
        'Removed groups/CLAUDE.md (context/ already has split files)',
      );
    }
  }

  for (const entry of fs.readdirSync(newAgentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const claudePath = path.join(newAgentsDir, entry.name, 'CLAUDE.md');
    const identityPath = path.join(newAgentsDir, entry.name, 'IDENTITY.md');
    if (fs.existsSync(claudePath) && !fs.existsSync(identityPath)) {
      fs.renameSync(claudePath, identityPath);
    }
  }

  const oldFile = path.join(DATA_DIR, 'registered_groups.json');
  const newFile = path.join(DATA_DIR, 'registered_agents.json');
  if (fs.existsSync(oldFile) && !fs.existsSync(newFile)) {
    fs.renameSync(oldFile, newFile);
  }

  // Move skills from agents/.claude/skills/ to top-level skills/
  // Then create .claude/skills symlink so the SDK auto-discovers them
  const oldSkillsDir = path.join(newAgentsDir, '.claude', 'skills');
  const newSkillsDir = path.join(NANOCLAW_HOME, 'skills');
  if (fs.existsSync(oldSkillsDir) && !fs.existsSync(newSkillsDir)) {
    fs.renameSync(oldSkillsDir, newSkillsDir);
  }
  const symlinkDir = path.join(NANOCLAW_HOME, '.claude');
  const symlinkPath = path.join(symlinkDir, 'skills');
  if (fs.existsSync(newSkillsDir) && !fs.existsSync(symlinkPath)) {
    fs.mkdirSync(symlinkDir, { recursive: true });
    fs.symlinkSync('../skills', symlinkPath);
  }

  logger.info('Migration complete');
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
  registeredAgents = loadJson(
    path.join(DATA_DIR, 'registered_agents.json'),
    {},
  );
  logger.info(
    { agentCount: Object.keys(registeredAgents).length },
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

function registerAgent(jid: string, agent: RegisteredAgent): void {
  registeredAgents[jid] = agent;
  saveJson(path.join(DATA_DIR, 'registered_agents.json'), registeredAgents);

  const agentDir = path.join(AGENTS_DIR, agent.folder);
  fs.mkdirSync(path.join(agentDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: agent.name, folder: agent.folder },
    'Agent registered',
  );
}

function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredAgents));

  return chats
    .filter(
      (c) =>
        c.jid !== '__group_sync__' &&
        (c.jid.endsWith('@g.us') ||
          c.jid.startsWith('tg:') ||
          c.jid.startsWith('imsg:')),
    )
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

const AUTO_REPLY_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

async function handleOffHoursReply(
  msg: NewMessage,
  agent: RegisteredAgent,
): Promise<void> {
  const last = lastAutoReply[msg.chat_jid];
  if (last && Date.now() - new Date(last).getTime() < AUTO_REPLY_COOLDOWN_MS)
    return;

  const ch = findChannel(channels, msg.chat_jid);
  if (!ch) return;

  let reply: string;
  if (agent.activeHours?.autoReply) {
    reply = agent.activeHours.autoReply;
  } else {
    try {
      const nextTime = getNextActiveTime(agent.activeHours!.cron);
      reply = `I'm currently offline. I'll be back ${formatNextActiveTime(nextTime)} and will catch up on messages then.`;
    } catch {
      reply = "I'm currently offline and will respond during active hours.";
    }
  }

  await ch.sendMessage(msg.chat_jid, reply);
  lastAutoReply[msg.chat_jid] = new Date().toISOString();
  logger.debug(
    { agent: agent.name, jid: msg.chat_jid },
    'Sent off-hours auto-reply',
  );
}

async function processMessage(msg: NewMessage): Promise<void> {
  const agent = registeredAgents[msg.chat_jid];
  if (!agent) return;

  let content = msg.content.trim();
  const isMainAgent = agent.folder === MAIN_AGENT_FOLDER;

  if (!isMainAgent) {
    if (agent.trigger) {
      const triggerPattern = new RegExp(
        `^${agent.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
        'i',
      );
      if (!triggerPattern.test(content)) return;
    }
  }

  if (agent.activeHours && !isInActiveWindow(agent.activeHours.cron)) {
    await handleOffHoursReply(msg, agent);
    return;
  }

  if (content === '/new' || content.toLowerCase().startsWith('/new ')) {
    if (sessions[agent.folder]) {
      flushBeforeSessionClear(agent.folder, sessions[agent.folder]);
    }
    delete sessions[agent.folder];
    saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    logger.info({ agent: agent.name }, 'Session cleared by user');

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
  const botPrefixes =
    DISPLAY_NAME !== ASSISTANT_NAME
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
    { agent: agent.name, messageCount: missedMessages.length },
    'Processing message',
  );

  const isVoice = content.startsWith('[Voice message]');
  const channel = findChannel(channels, msg.chat_jid);

  if (isVoice && channel && STT_ECHO_ENABLED) {
    const transcription = content.replace(/^\[Voice message\]\s*/, '');
    if (transcription) {
      await channel.sendMessage(msg.chat_jid, `> ${transcription}`);
    }
  }

  // Set up streaming if the channel supports it (Telegram)
  let streamingMsgId: number | undefined;
  let onText: ((text: string) => void) | undefined;
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  if (channel?.sendMessageWithId && channel?.editMessage) {
    try {
      streamingMsgId = await channel.sendMessageWithId(
        msg.chat_jid,
        '💬⏳\u200B',
      );
      // Animated typing indicator in the chat header, refreshed every 4s
      channel.setTyping?.(msg.chat_jid, true).catch(() => {});
      typingInterval = setInterval(() => {
        channel.setTyping?.(msg.chat_jid, true).catch(() => {});
      }, 4000);
      let lastEditTime = 0;
      onText = (text: string) => {
        // Stop typing indicator once text starts appearing
        if (typingInterval) {
          clearInterval(typingInterval);
          typingInterval = undefined;
        }
        if (Date.now() - lastEditTime >= 800) {
          lastEditTime = Date.now();
          channel.editMessage!(msg.chat_jid, streamingMsgId!, text).catch(
            () => {},
          );
        }
      };
    } catch (err) {
      logger.debug({ err }, 'Failed to send streaming placeholder');
    }
  }

  if (!streamingMsgId && channel) await channel.setTyping?.(msg.chat_jid, true);
  const { text: response, sentMediaViaIpc } = await runAgent(
    agent,
    prompt,
    msg.chat_jid,
    onText,
  );
  if (typingInterval) {
    clearInterval(typingInterval);
    typingInterval = undefined;
  }
  if (!streamingMsgId && channel)
    await channel.setTyping?.(msg.chat_jid, false);

  if (channel) {
    const cleaned = response ? stripInternalTags(response) : null;
    // When the agent sent media via IPC (e.g. canvas PNG), the caption is the
    // reply. Suppress the streaming placeholder regardless of what the agent
    // returned, so the user sees only the image+caption — not a duplicate
    // text message edited into the placeholder.
    if (sentMediaViaIpc) {
      lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
      if (streamingMsgId && channel.deleteMessage) {
        await channel
          .deleteMessage(msg.chat_jid, streamingMsgId)
          .catch(() => {});
      }
    } else if (cleaned && !isNonResponse(cleaned)) {
      lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
      if (streamingMsgId && channel.editMessage) {
        await channel.editMessage(msg.chat_jid, streamingMsgId, cleaned);
      } else {
        await channel.sendMessage(msg.chat_jid, cleaned);
      }
      if (isVoice && channel.sendMedia) {
        const audio = await generateSpeech(cleaned);
        if (audio) {
          await channel.sendMedia(
            msg.chat_jid,
            'audio',
            { buffer: audio },
            { ptt: true },
          );
        }
      }
    } else if (streamingMsgId && channel.deleteMessage) {
      await channel.deleteMessage(msg.chat_jid, streamingMsgId).catch(() => {});
    }
  }
}

function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

function isNonResponse(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.\s]+$/g, '');
  const suppressPatterns = [
    'no response requested',
    'no response needed',
    'no response necessary',
    'no response required',
  ];
  return suppressPatterns.includes(normalized);
}

async function runAgent(
  agent: RegisteredAgent,
  prompt: string,
  chatJid: string,
  onText?: (text: string) => void,
): Promise<{ text: string | null; sentMediaViaIpc: boolean }> {
  const isMain = agent.folder === MAIN_AGENT_FOLDER;
  const sessionId = sessions[agent.folder];

  const availableGroups = getAvailableGroups();
  writeAgentsSnapshot(
    agent.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredAgents)),
  );

  const handlers = getAllHandlers();
  writeHandlersSnapshot(agent.folder, isMain, handlers);

  try {
    const output = await runContainerAgent(agent, {
      prompt,
      sessionId,
      agentFolder: agent.folder,
      chatJid,
      isMain,
      onText,
    });

    if (output.newSessionId) {
      sessions[agent.folder] = output.newSessionId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    if (output.status === 'error') {
      logger.error(
        { agent: agent.name, error: output.error },
        'Container agent error',
      );
      if (output.timedOut) {
        return {
          text: 'Sorry, I ran out of time on that one. Try again?',
          sentMediaViaIpc: false,
        };
      }
      return { text: null, sentMediaViaIpc: !!output.sentMediaViaIpc };
    }

    return { text: output.result, sentMediaViaIpc: !!output.sentMediaViaIpc };
  } catch (err) {
    logger.error({ agent: agent.name, err }, 'Agent error');
    return { text: null, sentMediaViaIpc: false };
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
    let agentFolders: string[];
    try {
      agentFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceAgent of agentFolders) {
      const isMain = sourceAgent === MAIN_AGENT_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceAgent, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceAgent, 'tasks');

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
                // Resolve target JIDs: specific JID from chatJid, or all JIDs for the agent
                let targetJids: string[];
                if (data.chatJid) {
                  targetJids = [data.chatJid];
                } else {
                  // No originating channel (e.g. event handler). Prefer the
                  // folder's primary channel if one is flagged; otherwise fan
                  // out to every channel registered to the folder.
                  const folderJids = Object.entries(registeredAgents).filter(
                    ([, a]) => a.folder === data.agentFolder,
                  );
                  const primary = folderJids.find(([, a]) => a.primary);
                  targetJids = primary
                    ? [primary[0]]
                    : folderJids.map(([jid]) => jid);
                }

                for (const targetJid of targetJids) {
                  const targetAgent = registeredAgents[targetJid];
                  if (
                    !isMain &&
                    !(targetAgent && targetAgent.folder === sourceAgent)
                  ) {
                    logger.warn(
                      { targetJid, sourceAgent },
                      'Unauthorized IPC message attempt blocked',
                    );
                    continue;
                  }

                  const ipcChannel = findChannel(channels, targetJid);
                  if (!ipcChannel) {
                    logger.error(
                      { targetJid, sourceAgent },
                      'No channel found for target JID',
                    );
                    continue;
                  }

                  if (data.mediaType) {
                    const mediaSource = resolveMediaSource(
                      data.filePath,
                      data.mediaUrl,
                      sourceAgent,
                    );
                    if (mediaSource && ipcChannel.sendMedia) {
                      const caption = data.text || undefined;
                      const mediaType = data.mediaType as MediaType;
                      const fileName =
                        data.fileName ||
                        (data.filePath
                          ? path.basename(data.filePath)
                          : undefined);
                      const mimetype =
                        data.mimetype ||
                        guessMimetype(data.filePath || data.mediaUrl || '');

                      const ptt = (data as any).ptt || false;
                      if (data.sender && ipcChannel.sendMediaAsAgent) {
                        await ipcChannel.sendMediaAsAgent(
                          targetJid,
                          mediaType,
                          mediaSource,
                          { caption, fileName, mimetype, ptt },
                          data.sender,
                          sourceAgent,
                        );
                      } else {
                        await ipcChannel.sendMedia(
                          targetJid,
                          mediaType,
                          mediaSource,
                          { caption, fileName, mimetype, ptt },
                        );
                      }
                    } else if (!mediaSource) {
                      logger.error(
                        { targetJid, sourceAgent },
                        'Could not resolve media source',
                      );
                    } else {
                      logger.warn(
                        { targetJid, channel: ipcChannel.name },
                        'Channel does not support media',
                      );
                    }
                  } else if (data.sender && ipcChannel.sendAsAgent) {
                    await ipcChannel.sendAsAgent(
                      targetJid,
                      data.text,
                      data.sender,
                      sourceAgent,
                    );
                  } else {
                    await ipcChannel.sendMessage(targetJid, data.text);
                  }
                  logger.info(
                    {
                      targetJid,
                      sourceAgent,
                      mediaType: data.mediaType || 'text',
                    },
                    'IPC message sent',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceAgent, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceAgent}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceAgent },
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
              await processTaskIpc(data, sourceAgent, isMain);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceAgent, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceAgent}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceAgent }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-agent namespaces)');
}

async function processTaskIpc(
  data: {
    type: string;
    prompt?: string;
    cron?: string | null;
    runAt?: string | null;
    context_mode?: string;
    agentFolder?: string;
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
    targetAgent?: string;
    activeHours?: { cron: string; autoReply?: string };
  },
  sourceAgent: string,
  isMain: boolean,
): Promise<void> {
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task':
      if (data.prompt && data.agentFolder) {
        const targetAgent = data.agentFolder;
        if (!isMain && targetAgent !== sourceAgent) {
          logger.warn(
            { sourceAgent, targetAgent },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const handlerId = `handler-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'agent' || data.context_mode === 'isolated'
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
          group_folder: targetAgent,
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
          { handlerId, sourceAgent, targetAgent, contextMode, cron },
          'Scheduled handler created via IPC',
        );
      }
      break;

    case 'refresh_agents':
      if (isMain) {
        logger.info(
          { sourceAgent },
          'Agent metadata refresh requested via IPC',
        );
        for (const ch of channels) {
          await ch.syncMetadata?.(true);
        }
        const availableGroups = getAvailableGroups();
        writeAgentsSnapshot(
          sourceAgent,
          true,
          availableGroups,
          new Set(Object.keys(registeredAgents)),
        );
      } else {
        logger.warn(
          { sourceAgent },
          'Unauthorized refresh_agents attempt blocked',
        );
      }
      break;

    case 'emit_event':
      if (data.eventType) {
        emitEvent(data.eventType, data.payload || {});
        logger.info(
          { eventType: data.eventType, sourceAgent },
          'Event emitted via IPC',
        );
      }
      break;

    case 'register_handler':
      if (data.eventType && data.prompt) {
        const handlerTarget = data.targetAgent || sourceAgent;
        if (!isMain && handlerTarget !== sourceAgent) {
          logger.warn(
            { sourceAgent, targetAgent: handlerTarget },
            'Unauthorized register_handler attempt blocked',
          );
          break;
        }

        const handlerId = `handler-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const handlerContextMode =
          data.contextMode === 'agent' || data.contextMode === 'isolated'
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
          {
            handlerId,
            eventType: data.eventType,
            sourceAgent,
            targetAgent: handlerTarget,
          },
          'Handler registered via IPC',
        );
      }
      break;

    case 'pause_handler':
      if (data.handlerId) {
        const handler = getHandlerById(data.handlerId);
        if (handler && (isMain || handler.group_folder === sourceAgent)) {
          updateHandler(data.handlerId, { status: 'paused' });
          logger.info(
            { handlerId: data.handlerId, sourceAgent },
            'Handler paused via IPC',
          );
        } else {
          logger.warn(
            { handlerId: data.handlerId, sourceAgent },
            'Unauthorized handler pause attempt',
          );
        }
      }
      break;

    case 'resume_handler':
      if (data.handlerId) {
        const handler = getHandlerById(data.handlerId);
        if (handler && (isMain || handler.group_folder === sourceAgent)) {
          updateHandler(data.handlerId, { status: 'active' });
          logger.info(
            { handlerId: data.handlerId, sourceAgent },
            'Handler resumed via IPC',
          );
        } else {
          logger.warn(
            { handlerId: data.handlerId, sourceAgent },
            'Unauthorized handler resume attempt',
          );
        }
      }
      break;

    case 'cancel_handler':
      if (data.handlerId) {
        const handler = getHandlerById(data.handlerId);
        if (handler && (isMain || handler.group_folder === sourceAgent)) {
          deleteHandler(data.handlerId);
          logger.info(
            { handlerId: data.handlerId, sourceAgent },
            'Handler cancelled via IPC',
          );
        } else {
          logger.warn(
            { handlerId: data.handlerId, sourceAgent },
            'Unauthorized handler cancel attempt',
          );
        }
      }
      break;

    case 'register_agent':
      if (!isMain) {
        logger.warn(
          { sourceAgent },
          'Unauthorized register_agent attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        registerAgent(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          ...(data.activeHours ? { activeHours: data.activeHours } : {}),
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_agent request - missing required fields',
        );
      }
      break;

    case 'reply_email':
      if (
        data.requestId &&
        data.messageId &&
        data.to &&
        data.subject &&
        data.body
      ) {
        const emailResultsDir = path.join(
          DATA_DIR,
          'ipc',
          sourceAgent,
          'email_results',
        );
        fs.mkdirSync(emailResultsDir, { recursive: true });
        try {
          await sendEmailReply(
            data.messageId,
            data.to,
            data.subject,
            data.body,
          );
          const resultFile = path.join(
            emailResultsDir,
            `${data.requestId}.json`,
          );
          fs.writeFileSync(
            resultFile,
            JSON.stringify({ success: true, message: 'Email reply sent' }),
          );
          logger.info(
            { messageId: data.messageId, to: data.to, sourceAgent },
            'Email reply sent via IPC',
          );
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const resultFile = path.join(
            emailResultsDir,
            `${data.requestId}.json`,
          );
          fs.writeFileSync(
            resultFile,
            JSON.stringify({
              success: false,
              message: `Failed to send email: ${errorMsg}`,
            }),
          );
          logger.error(
            { messageId: data.messageId, err, sourceAgent },
            'Failed to send email reply via IPC',
          );
        }
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

function dispatchMessage(msg: NewMessage): void {
  const agent = registeredAgents[msg.chat_jid];
  if (!agent) return;
  const botPrefixes =
    DISPLAY_NAME !== ASSISTANT_NAME
      ? [DISPLAY_NAME, ASSISTANT_NAME]
      : [ASSISTANT_NAME];
  if (botPrefixes.some((p) => msg.content.startsWith(`${p}:`))) return;

  lastTimestamp = msg.timestamp;
  saveState();
  const prev = folderQueues.get(agent.folder) ?? Promise.resolve();
  const next = prev
    .then(() => processMessage(msg))
    .catch((err) =>
      logger.error({ err, msg: msg.id }, 'Error processing message'),
    );
  folderQueues.set(agent.folder, next);
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
      // Recovery sweep: catches messages missed during channel disconnects or restarts
      const jids = Object.keys(registeredAgents);
      const botPrefixes =
        DISPLAY_NAME !== ASSISTANT_NAME
          ? [DISPLAY_NAME, ASSISTANT_NAME]
          : [ASSISTANT_NAME];
      const { messages } = getNewMessages(jids, lastTimestamp, botPrefixes);
      if (messages.length > 0) {
        logger.info(
          { count: messages.length },
          'Recovery: dispatching missed messages',
        );
        for (const msg of messages) dispatchMessage(msg);
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
  migrateToAgents();
  loadState();
  initFlushCursors(sessions);
  startMemoryFlusher({ getSessions: () => sessions });
  initSubprocessManager();

  registerHeartbeatHandlers(registeredAgents);
  registerEmailHandlers(registeredAgents);
  registerDreamHandlers(registeredAgents);

  // Best-effort: backfill embeddings for any chunks created or migrated.
  void embedPendingChunks();

  // Initialize channels based on config
  if (!TELEGRAM_ONLY) {
    const whatsapp = new WhatsAppChannel({
      onMessage: (_chatJid, msg) => {
        storeMessage(msg);
        dispatchMessage(msg);
      },
      onChatMetadata: (chatJid, ts, name) =>
        storeChatMetadata(chatJid, ts, name),
      registeredAgents: () => registeredAgents,
    });
    channels.push(whatsapp);
    whatsapp.connect(); // fire-and-forget, internal reconnection
  }

  if (TELEGRAM_BOT_TOKEN) {
    const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, {
      onMessage: (_chatJid, msg) => {
        storeMessage(msg);
        dispatchMessage(msg);
      },
      onChatMetadata: (chatJid, timestamp, name) =>
        storeChatMetadata(chatJid, timestamp, name),
      registeredAgents: () => registeredAgents,
    });
    channels.push(telegram);
    await telegram.connect();
    if (TELEGRAM_BOT_POOL.length > 0) {
      await initBotPool(TELEGRAM_BOT_POOL);
    }
  }

  if (IMESSAGE_ENABLED) {
    const imessage = new IMessageChannel({
      onMessage: (_chatJid, msg) => {
        storeMessage(msg);
        dispatchMessage(msg);
      },
      onChatMetadata: (chatJid, ts, name) =>
        storeChatMetadata(chatJid, ts, name),
      registeredAgents: () => registeredAgents,
    });
    channels.push(imessage);
    await imessage.connect();
  }

  // Start all subsystems unconditionally
  startSchedulerEmitter();
  startEventBusLoop({
    registeredAgents: () => registeredAgents,
    getSessions: () => sessions,
    saveSessions: () =>
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions),
  });
  startIpcWatcher();
  startMessageLoop();
  startEmailLoops(registeredAgents);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
