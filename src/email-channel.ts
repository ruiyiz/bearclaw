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
import { runContainerAgent } from './agent-runner.js';
import { logger } from './logger.js';
import { EmailMessage, RegisteredGroup } from './types.js';
import { loadJson, saveJson } from './utils.js';

const GOG_PATH = '/opt/homebrew/bin/gog';
const STATE_FILE = path.join(DATA_DIR, 'email_state.json');
const MAX_PROCESSED_IDS = 1000;

export interface EmailDependencies {
  getSessions: () => Record<string, string>;
  saveSessions: (sessions: Record<string, string>) => void;
}

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

async function sendEmailReply(
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

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const emailGroup: RegisteredGroup = {
  name: 'Email',
  folder: EMAIL_GROUP_FOLDER,
  trigger: '',
  added_at: new Date().toISOString(),
};

async function processEmail(
  email: EmailMessage,
  deps: EmailDependencies,
): Promise<void> {
  const senderAddress = parseEmailAddress(email.from);
  logger.info(
    { messageId: email.id, threadId: email.threadId, from: senderAddress, subject: email.subject },
    'Processing email',
  );

  const prompt = [
    '<email>',
    `<from>${escapeXml(email.from)}</from>`,
    `<subject>${escapeXml(email.subject)}</subject>`,
    `<date>${escapeXml(email.date)}</date>`,
    `<body>${escapeXml(email.body)}</body>`,
    '</email>',
  ].join('\n');

  // Use per-thread session key
  const sessionKey = `email:${email.threadId}`;
  const sessions = deps.getSessions();
  const sessionId = sessions[sessionKey];

  // Ensure group directory exists
  const groupDir = path.join(GROUPS_DIR, EMAIL_GROUP_FOLDER);
  fs.mkdirSync(groupDir, { recursive: true });

  try {
    const output = await runContainerAgent(emailGroup, {
      prompt,
      sessionId,
      groupFolder: EMAIL_GROUP_FOLDER,
      chatJid: `email:${email.threadId}`,
      isMain: false,
    });

    if (output.newSessionId) {
      sessions[sessionKey] = output.newSessionId;
      deps.saveSessions(sessions);
    }

    if (output.status === 'error') {
      logger.error(
        { messageId: email.id, error: output.error },
        'Email agent error',
      );
      return;
    }

    if (output.result) {
      const replySubject = email.subject.startsWith('Re:')
        ? email.subject
        : `Re: ${email.subject}`;
      await sendEmailReply(
        email.id,
        senderAddress,
        replySubject,
        output.result,
      );
      logger.info(
        { messageId: email.id, threadId: email.threadId },
        'Email reply sent',
      );
    }
  } catch (err) {
    logger.error({ messageId: email.id, err }, 'Failed to process email');
  }
}

export function startEmailLoop(deps: EmailDependencies): void {
  if (emailLoopRunning) {
    logger.debug('Email loop already running, skipping duplicate start');
    return;
  }
  emailLoopRunning = true;
  logger.info(
    { address: EMAIL_TRIGGER_ADDRESS, interval: EMAIL_POLL_INTERVAL },
    'Email loop started',
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

        await processEmail(email, deps);

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
