import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  EMAIL_GROUP_FOLDER,
  EMAIL_POLL_INTERVAL,
  EMAIL_TRIGGER_ADDRESS,
  GROUPS_DIR,
} from './config.js';
import { createHandler, emitEvent, getHandlersForGroup } from './db.js';
import { logger } from './logger.js';
import { EmailMessage } from './types.js';
import { loadJson, saveJson } from './utils.js';

const GOG_PATH = '/opt/homebrew/bin/gog';
const STATE_FILE = path.join(DATA_DIR, 'email_state.json');
const MAX_PROCESSED_IDS = 1000;

interface EmailState {
  processedIds: string[];
}

let emailLoopRunning = false;

function loadEmailState(): Set<string> {
  const state = loadJson<EmailState>(STATE_FILE, { processedIds: [] });
  return new Set(state.processedIds);
}

function saveEmailState(processedIds: Set<string>): void {
  // Cap at MAX_PROCESSED_IDS, keeping newest
  const ids = Array.from(processedIds);
  const trimmed = ids.length > MAX_PROCESSED_IDS
    ? ids.slice(ids.length - MAX_PROCESSED_IDS)
    : ids;
  saveJson(STATE_FILE, { processedIds: trimmed });
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

async function fetchUnreadEmails(): Promise<EmailMessage[]> {
  const output = await runGog([
    'gmail', 'messages', 'search',
    `to:${EMAIL_TRIGGER_ADDRESS} is:unread`,
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

export function parseEmailAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
}

/**
 * Ensure a default email_received handler exists for the email group.
 * Called once on startup — if one already exists, this is a no-op.
 */
function ensureDefaultEmailHandler(): void {
  const handlers = getHandlersForGroup(EMAIL_GROUP_FOLDER);
  const hasEmailHandler = handlers.some(
    (h) => h.event_type === 'email_received' && h.status === 'active',
  );

  if (hasEmailHandler) {
    logger.debug('Default email_received handler already exists');
    return;
  }

  const handlerId = `handler-email-default-${Date.now()}`;
  createHandler({
    id: handlerId,
    group_folder: EMAIL_GROUP_FOLDER,
    prompt: `Process this email. The event payload contains the full email (from, subject, body, thread_id, message_id).
If a response is needed, use the reply_email tool. If no response is needed, do nothing.`,
    context_mode: 'group',
    event_type: 'email_received',
    filter: null,
    cron: null,
    next_run: null,
    cooldown_ms: 0,
    max_triggers: null,
    status: 'active',
    created_at: new Date().toISOString(),
  });

  logger.info({ handlerId }, 'Default email_received handler registered');
}

export function startEmailLoop(): void {
  if (emailLoopRunning) {
    logger.debug('Email loop already running, skipping duplicate start');
    return;
  }
  emailLoopRunning = true;

  // Ensure group directory exists
  fs.mkdirSync(path.join(GROUPS_DIR, EMAIL_GROUP_FOLDER), { recursive: true });

  // Auto-register default handler if none exists
  ensureDefaultEmailHandler();

  logger.info(
    { address: EMAIL_TRIGGER_ADDRESS, interval: EMAIL_POLL_INTERVAL },
    'Email emitter started',
  );

  const processedIds = loadEmailState();

  const poll = async () => {
    try {
      const emails = await fetchUnreadEmails();
      if (emails.length > 0) {
        logger.info({ count: emails.length }, 'Found unread emails');
      }

      for (const email of emails) {
        if (processedIds.has(email.id)) {
          logger.debug({ messageId: email.id }, 'Skipping already-processed email');
          continue;
        }

        // Emit event with full email body + session_key for per-thread sessions
        emitEvent('email_received', {
          message_id: email.id,
          thread_id: email.threadId,
          from: parseEmailAddress(email.from),
          from_raw: email.from,
          subject: email.subject,
          body: email.body,
          date: email.date,
          session_key: `email:${email.threadId}`,
        });

        // Mark processed
        processedIds.add(email.id);
        saveEmailState(processedIds);

        // Mark thread as read in Gmail
        try {
          await markThreadRead(email.threadId);
        } catch (err) {
          logger.error({ threadId: email.threadId, err }, 'Failed to mark thread read');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in email poll');
    }

    setTimeout(poll, EMAIL_POLL_INTERVAL);
  };

  // Run first poll immediately
  poll();
}
