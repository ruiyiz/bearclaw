import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { marked } from 'marked';

import { DATA_DIR, EMAIL_DEFAULT_INTERVAL, agentVarDir } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredAgent,
} from '../types.js';
import { loadJson, saveJson } from '../utils/json.js';

// Email as a first-class channel. Routing jids:
//   email:<folder>:<threadId>  — an inbound thread (reply target)
//   email:<folder>             — the folder's mailbox (proactive send target)
// One channel owns every email thread; per-folder poll loops feed inbound
// messages through the same dispatch path the other channels use, and replies
// are delivered structurally (by jid) rather than at the agent's discretion.

const GWS_PATH = 'gws';
const MAX_PROCESSED_IDS = 1000;
const EMAIL_JID_PREFIX = 'email:';
// Look back two days so a message read (by a human or a filter) before the
// poll catches it is still visible — detection no longer depends on the
// mutable UNREAD label.
const POLL_WINDOW = 'newer_than:2d';
const POLL_MAX = 25;

export function isEmailJid(jid: string): boolean {
  return jid.startsWith(EMAIL_JID_PREFIX);
}

export function emailFolderJid(folder: string): string {
  return `${EMAIL_JID_PREFIX}${folder}`;
}

export function emailThreadJid(folder: string, threadId: string): string {
  return `${EMAIL_JID_PREFIX}${folder}:${threadId}`;
}

// Split email:<folder>[:<threadId>]. Folder names never contain ':'; thread
// ids are hex, so the first ':' after the prefix separates them.
export function parseEmailJid(jid: string): {
  folder: string;
  threadId?: string;
} {
  const rest = jid.slice(EMAIL_JID_PREFIX.length);
  const colon = rest.indexOf(':');
  return colon === -1
    ? { folder: rest }
    : { folder: rest.slice(0, colon), threadId: rest.slice(colon + 1) };
}

interface EmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredAgents: () => Record<string, RegisteredAgent>;
}

interface EmailState {
  processedIds: string[];
  // threadId → latest Gmail API message id seen, so a reply can thread under
  // the right message even after a process restart.
  threads: Record<string, string>;
}

interface FolderPoll {
  folder: string;
  address: string;
  intervalMs: number;
  processedIds: Set<string>;
  threadMsgId: Map<string, string>;
  timer?: ReturnType<typeof setTimeout>;
  lastPollOk: boolean;
  lastPollError?: string;
  lastPollAt?: string;
}

function intervalToMs(interval: string): number {
  const match = interval.match(/^(\d+)(m|h|d)$/);
  if (!match) return 3600000;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      return 3600000;
  }
}

function runGws(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      GWS_PATH,
      args,
      { timeout: 60000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `gws ${args.slice(0, 3).join(' ')} failed: ${stderr || err.message}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

// gws prefixes stdout with status lines ("Using keyring backend…"). Parse from
// the first JSON token; null when there is none.
function parseJsonOutput<T>(raw: string): T | null {
  const start = raw.search(/[{[]/);
  if (start === -1) return null;
  return JSON.parse(raw.slice(start)) as T;
}

// Strip the +tag from a plus-addressed alias: foo+bar@x → foo@x. Used to derive
// the real owner mailbox for proactive sends.
export function baseAddress(address: string): string {
  return address.replace(/\+[^@]*(?=@)/, '');
}

export function hasPlusTag(address: string): boolean {
  return /\+[^@]+@/.test(address);
}

function parseEmailAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1].trim() : from.trim();
}

export function firstLineSubject(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find((l) => l.length > 0) || '(no subject)';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

export function mdToHtml(md: string): string {
  return marked.parse(md, { async: false }) as string;
}

interface TriageEntry {
  id: string;
  from?: string;
  subject?: string;
  date?: string;
}
interface TriageResponse {
  messages?: TriageEntry[];
}
interface ReadResponse {
  thread_id: string;
  from?: { name?: string | null; email?: string } | null;
  subject?: string;
  date?: string;
  body_text?: string;
}
interface MessagePart {
  mimeType?: string;
  filename?: string;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: MessagePart[];
}
interface FullMessage {
  payload?: MessagePart;
}

export class EmailChannel implements Channel {
  name = 'email';

  private opts: EmailChannelOpts;
  private connected = false;
  private polls = new Map<string, FolderPoll>();

  constructor(opts: EmailChannelOpts) {
    this.opts = opts;
  }

  ownsJid(jid: string): boolean {
    return isEmailJid(jid);
  }

  isConnected(): boolean {
    if (!this.connected) return false;
    // Healthy when no folder's most recent poll ended in error.
    for (const p of this.polls.values()) if (!p.lastPollOk) return false;
    return true;
  }

  async disconnect(): Promise<void> {
    for (const p of this.polls.values()) if (p.timer) clearTimeout(p.timer);
    this.connected = false;
  }

  // Build folder→address/interval from the resolved registry. Each polling
  // address must be plus-tagged (so replies, sent from the base account, are
  // never re-polled); reject and skip otherwise.
  async connect(): Promise<void> {
    this.connected = true;
    const seen = new Set<string>();
    for (const agent of Object.values(this.opts.registeredAgents())) {
      if (!agent.email?.address) continue;
      if (seen.has(agent.folder)) continue;
      seen.add(agent.folder);
      const address = agent.email.address;
      if (!hasPlusTag(address)) {
        logger.error(
          { folder: agent.folder, address },
          'Email address has no +tag — refusing to poll (reply loop risk)',
        );
        continue;
      }
      this.startFolderPoll(
        agent.folder,
        address,
        agent.email.interval || EMAIL_DEFAULT_INTERVAL,
      );
    }
    logger.info({ folders: [...this.polls.keys()] }, 'Email channel ready');
  }

  private stateFile(folder: string): string {
    return path.join(DATA_DIR, `email_state_${folder}.json`);
  }

  private statusFile(folder: string): string {
    return path.join(DATA_DIR, `email_status_${folder}.json`);
  }

  private loadState(folder: string): {
    ids: Set<string>;
    threads: Map<string, string>;
  } {
    const s = loadJson<EmailState>(this.stateFile(folder), {
      processedIds: [],
      threads: {},
    });
    return {
      ids: new Set(s.processedIds || []),
      threads: new Map(Object.entries(s.threads || {})),
    };
  }

  private saveState(poll: FolderPoll): void {
    const ids = [...poll.processedIds];
    const trimmed =
      ids.length > MAX_PROCESSED_IDS ? ids.slice(-MAX_PROCESSED_IDS) : ids;
    saveJson(this.stateFile(poll.folder), {
      processedIds: trimmed,
      threads: Object.fromEntries(poll.threadMsgId),
    } satisfies EmailState);
  }

  private writeStatus(poll: FolderPoll): void {
    saveJson(this.statusFile(poll.folder), {
      address: poll.address,
      lastPollOk: poll.lastPollOk,
      lastPollAt: poll.lastPollAt,
      lastPollError: poll.lastPollError ?? null,
    });
  }

  private startFolderPoll(
    folder: string,
    address: string,
    interval: string,
  ): void {
    if (this.polls.has(folder)) return;
    const state = this.loadState(folder);
    const poll: FolderPoll = {
      folder,
      address,
      intervalMs: intervalToMs(interval),
      processedIds: state.ids,
      threadMsgId: state.threads,
      lastPollOk: true,
    };
    this.polls.set(folder, poll);
    logger.info(
      { folder, address, intervalMs: poll.intervalMs },
      'Email poll started',
    );
    const tick = () => {
      void this.poll(poll).finally(() => {
        poll.timer = setTimeout(tick, poll.intervalMs);
      });
    };
    tick();
  }

  private async poll(poll: FolderPoll): Promise<void> {
    try {
      const out = await runGws([
        'gmail',
        '+triage',
        '--query',
        `to:${poll.address} ${POLL_WINDOW}`,
        '--max',
        String(POLL_MAX),
        '--format',
        'json',
      ]);
      const triage = parseJsonOutput<TriageResponse>(out);
      const messages = triage?.messages ?? [];
      if (messages.length >= POLL_MAX) {
        logger.warn(
          { folder: poll.folder, max: POLL_MAX },
          'Email poll hit --max; older messages this window may be skipped',
        );
      }

      for (const entry of messages) {
        if (poll.processedIds.has(entry.id)) continue;
        try {
          await this.ingest(poll, entry);
        } catch (err) {
          logger.warn(
            { err, id: entry.id, folder: poll.folder },
            'Failed to ingest email, skipping',
          );
        }
        poll.processedIds.add(entry.id);
        this.saveState(poll);
      }

      poll.lastPollOk = true;
      poll.lastPollError = undefined;
    } catch (err) {
      poll.lastPollOk = false;
      poll.lastPollError = err instanceof Error ? err.message : String(err);
      logger.error({ err, folder: poll.folder }, 'Error in email poll');
    } finally {
      poll.lastPollAt = new Date().toISOString();
      this.writeStatus(poll);
    }
  }

  private async ingest(poll: FolderPoll, entry: TriageEntry): Promise<void> {
    const readOut = await runGws([
      'gmail',
      '+read',
      '--id',
      entry.id,
      '--headers',
      '--format',
      'json',
    ]);
    const read = parseJsonOutput<ReadResponse>(readOut);
    if (!read) {
      logger.warn({ id: entry.id }, 'Empty +read output, skipping');
      return;
    }

    const threadId = read.thread_id;
    // Remember the latest message id for this thread so replies can thread.
    poll.threadMsgId.set(threadId, entry.id);

    const fromObj = read.from || null;
    const fromName = fromObj?.name || undefined;
    const fromAddr = fromObj?.email
      ? fromObj.email
      : parseEmailAddress(entry.from || '');
    const fromDisplay = fromName ? `${fromName} <${fromAddr}>` : fromAddr;
    const subject = read.subject || entry.subject || '(no subject)';
    const body = read.body_text || '';

    let content = `From: ${fromDisplay}\nSubject: ${subject}\n\n${body}`;

    const attachments = await this.ingestAttachments(
      poll.folder,
      entry.id,
      threadId,
    );
    if (attachments.length > 0) {
      content += `\n\n${attachments.map((p) => `[Attachment saved: ${p}]`).join('\n')}`;
    }

    const jid = emailThreadJid(poll.folder, threadId);
    const timestamp = read.date
      ? new Date(read.date).toISOString()
      : new Date().toISOString();

    this.opts.onChatMetadata(jid, timestamp, firstLineSubject(subject));
    const msg: NewMessage = {
      id: `email-${entry.id}`,
      chat_jid: jid,
      sender: fromAddr,
      sender_name: fromName || fromAddr,
      content,
      timestamp,
    };
    this.opts.onMessage(jid, msg);
  }

  // Walk the full message MIME tree, fetch each attachment part and write it to
  // the agent's inbox so the agent can Read it. Best-effort: failures are
  // logged and skipped.
  private async ingestAttachments(
    folder: string,
    messageId: string,
    threadId: string,
  ): Promise<string[]> {
    let full: FullMessage | null = null;
    try {
      const out = await runGws([
        'gmail',
        'users',
        'messages',
        'get',
        '--params',
        JSON.stringify({ userId: 'me', id: messageId, format: 'full' }),
        '--format',
        'json',
      ]);
      full = parseJsonOutput<FullMessage>(out);
    } catch (err) {
      logger.warn({ err, messageId }, 'Failed to fetch full message');
      return [];
    }
    if (!full?.payload) return [];

    const parts: MessagePart[] = [];
    const walk = (part: MessagePart) => {
      if (part.filename && part.body?.attachmentId) parts.push(part);
      for (const child of part.parts || []) walk(child);
    };
    walk(full.payload);
    if (parts.length === 0) return [];

    const outDir = path.join(agentVarDir(folder), 'inbox', threadId);
    fs.mkdirSync(outDir, { recursive: true });

    const saved: string[] = [];
    for (const part of parts) {
      try {
        const attOut = await runGws([
          'gmail',
          'users',
          'messages',
          'attachments',
          'get',
          '--params',
          JSON.stringify({
            userId: 'me',
            messageId,
            id: part.body!.attachmentId,
          }),
          '--format',
          'json',
        ]);
        const att = parseJsonOutput<{ data?: string }>(attOut);
        if (!att?.data) continue;
        const buf = Buffer.from(
          att.data.replace(/-/g, '+').replace(/_/g, '/'),
          'base64',
        );
        const filePath = path.join(outDir, sanitizeFilename(part.filename!));
        fs.writeFileSync(filePath, buf);
        saved.push(filePath);
      } catch (err) {
        logger.warn(
          { err, messageId, filename: part.filename },
          'Failed to fetch attachment, skipping',
        );
      }
    }
    return saved;
  }

  // Outbound: parse the jid and deliver structurally. A thread jid replies
  // under the captured message id; a bare folder jid sends a fresh email to the
  // owner mailbox (the polling address with its +tag stripped).
  async sendMessage(jid: string, text: string): Promise<void> {
    if (!text.trim()) return;
    const { folder, threadId } = parseEmailJid(jid);
    const poll = this.polls.get(folder);
    const html = mdToHtml(text);

    if (threadId) {
      const msgId =
        poll?.threadMsgId.get(threadId) ??
        this.loadState(folder).threads.get(threadId);
      if (!msgId) {
        logger.error(
          { folder, threadId },
          'No message id for thread — cannot send email reply',
        );
        return;
      }
      await runGws([
        'gmail',
        '+reply',
        '--message-id',
        msgId,
        '--body',
        html,
        '--html',
      ]);
      logger.info({ folder, threadId }, 'Email reply sent');
      return;
    }

    if (!poll) {
      logger.error({ folder }, 'No email poll for folder — cannot send email');
      return;
    }
    const to = baseAddress(poll.address);
    await runGws([
      'gmail',
      '+send',
      '--to',
      to,
      '--subject',
      firstLineSubject(text),
      '--body',
      html,
      '--html',
    ]);
    logger.info({ folder, to }, 'Proactive email sent');
  }
}

function sanitizeFilename(name: string): string {
  const base = name.replace(/[/\\]/g, '_').replace(/\.\.+/g, '.');
  return base.slice(0, 200) || 'attachment';
}
