import { execFile } from 'child_process';
import path from 'path';

import { DATA_DIR, EMAIL_DEFAULT_INTERVAL, EMAIL_HANDLER_PREFIX } from '../config.js';
import { createHandler, emitEvent, getAllHandlers, updateHandler } from '../db.js';
import { logger } from '../logger.js';
import { EmailMessage, RegisteredAgent } from '../types.js';
import { loadJson, saveJson } from '../utils/json.js';

const GOG_PATH = '/opt/homebrew/bin/gog';
const MAX_PROCESSED_IDS = 1000;

interface EmailState {
  processedIds: string[];
}

/** Convert an interval string like "30m", "1h" to milliseconds. */
function intervalToMs(interval: string): number {
  const match = interval.match(/^(\d+)(m|h|d)$/);
  if (!match) return 3600000; // default 1h
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return 3600000;
  }
}

function stateFile(folder: string): string {
  return path.join(DATA_DIR, `email_state_${folder}.json`);
}

function loadEmailState(folder: string): Set<string> {
  const state = loadJson<EmailState>(stateFile(folder), { processedIds: [] });
  return new Set(state.processedIds);
}

function saveEmailState(folder: string, processedIds: Set<string>): void {
  const ids = Array.from(processedIds);
  const trimmed = ids.length > MAX_PROCESSED_IDS
    ? ids.slice(ids.length - MAX_PROCESSED_IDS)
    : ids;
  saveJson(stateFile(folder), { processedIds: trimmed });
}

function runGog(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      GOG_PATH,
      args,
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`gog ${args[0]} ${args[1] || ''} failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      },
    );
    if (stdin && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

async function fetchUnreadEmails(address: string): Promise<EmailMessage[]> {
  const output = await runGog([
    'gmail', 'messages', 'search',
    `to:${address} is:unread`,
    '--json', '--no-input', '--include-body', '--max=10',
  ]);

  const data = JSON.parse(output);
  if (!data.messages || !Array.isArray(data.messages)) {
    return [];
  }

  return data.messages.map((m: {
    id: string;
    threadId: string;
    from: string;
    subject: string;
    body: string;
    date: string;
  }) => ({
    id: m.id,
    threadId: m.threadId,
    from: m.from,
    subject: m.subject || '(no subject)',
    body: m.body || '',
    date: m.date || '',
  }));
}

async function markThreadRead(threadId: string): Promise<void> {
  await runGog([
    'gmail', 'thread', 'modify', threadId,
    '--remove=UNREAD', '--no-input',
  ]);
}

export async function sendEmailReply(
  messageId: string,
  to: string,
  subject: string,
  body: string,
): Promise<void> {
  await runGog(
    [
      'gmail', 'send',
      `--to=${to}`,
      `--subject=${subject}`,
      '--body-file=-',
      `--reply-to-message-id=${messageId}`,
      '--no-input', '--json',
    ],
    body,
  );
}

function parseEmailAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
}

// Track running loops to prevent duplicates on reconnect
const runningLoops = new Set<string>();

/**
 * Start email polling loops for all agents that have email config.
 * Each agent gets its own loop with its own state file and interval.
 */
export function startEmailLoops(agents: Record<string, RegisteredAgent>): void {
  for (const agent of Object.values(agents)) {
    if (!agent.email) continue;
    if (runningLoops.has(agent.folder)) {
      logger.debug({ folder: agent.folder }, 'Email loop already running, skipping');
      continue;
    }
    runningLoops.add(agent.folder);

    const { address, interval } = agent.email;
    const pollMs = intervalToMs(interval || EMAIL_DEFAULT_INTERVAL);
    const processedIds = loadEmailState(agent.folder);

    logger.info(
      { folder: agent.folder, address, intervalMs: pollMs },
      'Email loop started',
    );

    const poll = async () => {
      try {
        const emails = await fetchUnreadEmails(address);
        if (emails.length > 0) {
          logger.info({ count: emails.length, folder: agent.folder }, 'Found unread emails');
        }

        for (const email of emails) {
          if (processedIds.has(email.id)) {
            logger.debug({ messageId: email.id }, 'Skipping already-processed email');
            continue;
          }

          emitEvent('email_received', {
            group_folder: agent.folder,
            message_id: email.id,
            thread_id: email.threadId,
            from: parseEmailAddress(email.from),
            from_raw: email.from,
            subject: email.subject,
            body: email.body,
            date: email.date,
            session_key: `email:${email.threadId}`,
          });

          processedIds.add(email.id);
          saveEmailState(agent.folder, processedIds);

          try {
            await markThreadRead(email.threadId);
          } catch (err) {
            logger.error({ threadId: email.threadId, err }, 'Failed to mark thread read');
          }
        }
      } catch (err) {
        logger.error({ err, folder: agent.folder }, 'Error in email poll');
      }

      setTimeout(poll, pollMs);
    };

    poll();
  }
}

/**
 * Register email_received handlers for all agents with email config.
 * Mirrors the Heartbeat pattern: creates/updates/pauses handlers based on config.
 */
export function registerEmailHandlers(agents: Record<string, RegisteredAgent>): void {
  const existingHandlers = getAllHandlers();
  const emailHandlers = new Map(
    existingHandlers
      .filter((h) => h.id.startsWith(EMAIL_HANDLER_PREFIX))
      .map((h) => [h.id, h]),
  );

  // Reduce agents to per-folder desired email state. Multiple agents may share
  // a folder (e.g. iMessage + WhatsApp both routed to "coco"); the handler is
  // per-folder, so any agent in that folder having email config is enough.
  const folderHasEmail = new Set<string>();
  const allFolders = new Set<string>();
  for (const agent of Object.values(agents)) {
    allFolders.add(agent.folder);
    if (agent.email) folderHasEmail.add(agent.folder);
  }

  const seenHandlerIds = new Set<string>();

  for (const folder of allFolders) {
    const handlerId = `${EMAIL_HANDLER_PREFIX}${folder}`;
    seenHandlerIds.add(handlerId);

    const existing = emailHandlers.get(handlerId);

    if (!folderHasEmail.has(folder)) {
      // No email config for this folder — pause existing handler if any
      if (existing && existing.status === 'active') {
        updateHandler(handlerId, { status: 'paused' });
        logger.info({ handlerId }, 'Email handler paused (config removed)');
      }
      continue;
    }

    const filter = JSON.stringify({ group_folder: folder });
    const prompt = `Process this email. The event payload contains the full email (from, subject, body, thread_id, message_id).
If a response is needed, use the reply_email tool. If no response is needed, do nothing.`;

    if (existing) {
      // Handler exists — ensure active with correct filter/prompt
      const updates: Parameters<typeof updateHandler>[1] = {};
      if (existing.status !== 'active') updates.status = 'active';
      if (existing.prompt !== prompt) updates.prompt = prompt;
      if (existing.filter !== filter) updates.filter = filter;
      if (Object.keys(updates).length > 0) {
        updateHandler(handlerId, updates);
        logger.info({ handlerId }, 'Email handler updated');
      }
      continue;
    }

    // Create new handler
    createHandler({
      id: handlerId,
      group_folder: folder,
      prompt,
      context_mode: 'agent',
      event_type: 'email_received',
      filter,
      cron: null,
      next_run: null,
      cooldown_ms: 0,
      max_triggers: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    logger.info({ handlerId, folder }, 'Email handler created');
  }

  // Pause any email handlers for folders that no longer exist
  for (const [handlerId, handler] of emailHandlers) {
    if (!seenHandlerIds.has(handlerId) && handler.status === 'active') {
      updateHandler(handlerId, { status: 'paused' });
      logger.info({ handlerId }, 'Email handler paused (agent removed)');
    }
  }
}
