import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';

import {
  ASSISTANT_NAME,
  DISPLAY_NAME,
  LOG_DIR,
  TRIGGER_PATTERN,
  agentVarDir,
} from '../config.js';
import { renderMarkdown, PlainTextRenderer } from '../media/format.js';
import { logger } from '../logger.js';
import {
  Channel,
  MediaType,
  MediaSource,
  MediaOptions,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredAgent,
} from '../types.js';

const execFileAsync = promisify(execFile);

// Path to the file that `imsg watch --json --attachments` is piped into.
// The user runs: imsg watch --json --attachments >> ~/.nanoclaw/var/log/imsg-watch.jsonl
const IMSG_WATCH_FILE = path.join(LOG_DIR, 'imsg-watch.jsonl');

interface IMessageChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredAgents: () => Record<string, RegisteredAgent>;
}

// JSON shape emitted by `imsg watch --json --attachments`
interface ImsgWatchEvent {
  id: number;
  chat_id: number;
  text?: string;
  is_from_me: boolean;
  created_at: string; // ISO8601
  sender?: string;
  guid?: string;
  attachments?: ImsgAttachment[];
}

interface ImsgAttachment {
  filename?: string;
  original_path?: string;
  mime_type?: string;
  transfer_name?: string;
}

const POLL_MS = 1000;

export class IMessageChannel implements Channel {
  name = 'imessage';

  private opts: IMessageChannelOpts;
  private connected = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private fileOffset = 0; // byte offset in imsg-watch.jsonl we've already processed
  private seenRowids = new Set<number>();

  constructor(opts: IMessageChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Seek to end of existing file so we only process new lines
    try {
      const stat = fs.statSync(IMSG_WATCH_FILE);
      this.fileOffset = stat.size;
    } catch {
      this.fileOffset = 0;
    }

    this.connected = true;
    this.schedulePoll();

    logger.info(
      { watchFile: IMSG_WATCH_FILE },
      'iMessage channel connected (file-tail mode)',
    );
    console.log('\n  iMessage channel active (file-tail mode)');
    console.log(`  In a terminal with Full Disk Access, run:`);
    console.log(`  imsg watch --json --attachments >> ${IMSG_WATCH_FILE}`);
    console.log(
      '  Register chats with JID: imsg:<chatID>  (from: imsg chats --json)\n',
    );
  }

  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => this.poll(), POLL_MS);
  }

  private poll(): void {
    if (!this.connected) return;
    try {
      this.readNewLines();
    } catch (err) {
      logger.debug({ err }, 'iMessage poll error');
    }
    this.schedulePoll();
  }

  private readNewLines(): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(IMSG_WATCH_FILE);
    } catch {
      return; // file doesn't exist yet
    }

    if (stat.size <= this.fileOffset) {
      if (stat.size < this.fileOffset) this.fileOffset = 0; // file was truncated/rotated
      // Truncate once fully caught up and file exceeds 10 MB
      if (stat.size > 10 * 1024 * 1024) {
        fs.truncateSync(IMSG_WATCH_FILE, 0);
        this.fileOffset = 0;
        logger.info('iMessage watch file truncated');
      }
      return;
    }

    const fd = fs.openSync(IMSG_WATCH_FILE, 'r');
    const toRead = stat.size - this.fileOffset;
    const buf = Buffer.alloc(toRead);
    fs.readSync(fd, buf, 0, toRead, this.fileOffset);
    fs.closeSync(fd);
    this.fileOffset = stat.size;

    const text = buf.toString('utf-8');
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event: ImsgWatchEvent = JSON.parse(trimmed);
        this.handleWatchEvent(event);
      } catch {
        // Not JSON - skip
      }
    }
  }

  private handleWatchEvent(event: ImsgWatchEvent): void {
    if (this.seenRowids.has(event.id)) return;
    this.seenRowids.add(event.id);

    const chatJid = `imsg:${event.chat_id}`;
    const agent = this.opts.registeredAgents()[chatJid];
    if (!agent) {
      logger.debug(
        { chatJid, chat_id: event.chat_id },
        'iMessage from unregistered chat',
      );
      return;
    }

    const timestamp = event.created_at || new Date().toISOString();
    const sender = event.sender || '';
    const msgId = String(event.id);

    this.opts.onChatMetadata(chatJid, timestamp);

    let content = (event.text || '').trim();

    // Normalize @AssistantName mentions to trigger format
    if (content && !TRIGGER_PATTERN.test(content)) {
      const mentionPattern = new RegExp(`@${ASSISTANT_NAME}\\b`, 'i');
      if (mentionPattern.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Copy attachments into agent media dir
    if (event.attachments && event.attachments.length > 0) {
      const mediaParts: string[] = [];
      for (const att of event.attachments) {
        const srcPath = att.original_path || att.filename;
        if (!srcPath) continue;

        const expanded = srcPath.startsWith('~')
          ? srcPath.replace('~', process.env.HOME || '')
          : srcPath;

        if (!fs.existsSync(expanded)) continue;

        const mime = att.mime_type || '';
        const originalName = att.transfer_name || path.basename(expanded);
        // Normalize Unicode whitespace (e.g. NARROW NO-BREAK SPACE U+202F in
        // macOS screenshot filenames) to ASCII so the agent can reproduce the
        // path verbatim when calling tools like image_generate.
        const safeName = originalName.replace(/\s+/gu, ' ');
        const mediaDir = path.join(agentVarDir(agent.folder), 'media');
        fs.mkdirSync(mediaDir, { recursive: true });
        const destPath = path.join(mediaDir, `imsg-${event.id}-${safeName}`);
        fs.copyFileSync(expanded, destPath);

        if (mime.startsWith('image/')) {
          mediaParts.push(`[Photo: ${destPath}]`);
        } else if (mime.startsWith('video/')) {
          mediaParts.push(`[Video: ${destPath}]`);
        } else if (mime.startsWith('audio/')) {
          mediaParts.push(`[Audio: ${destPath}]`);
        } else {
          mediaParts.push(`[Attachment: ${destPath}]`);
        }
        logger.debug({ destPath }, 'iMessage attachment copied');
      }
      if (mediaParts.length > 0) {
        content = [content, ...mediaParts].filter(Boolean).join(' ');
      }
    }

    if (!content) return;

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: sender,
      content,
      timestamp,
    });

    logger.info({ chatJid, sender, id: event.id }, 'iMessage received');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace(/^imsg:/, '');
    const plain = renderMarkdown(text, PlainTextRenderer);
    const prefixed = `${DISPLAY_NAME}: ${plain}`;
    try {
      await execFileAsync('imsg', [
        'send',
        '--chat-id',
        chatId,
        '--text',
        prefixed,
      ]);
      logger.info({ jid, length: text.length }, 'iMessage sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send iMessage');
    }
  }

  async sendMedia(
    jid: string,
    type: MediaType,
    source: MediaSource,
    options?: MediaOptions,
  ): Promise<void> {
    const chatId = jid.replace(/^imsg:/, '');

    let filePath: string | null = null;
    let tempFile: string | null = null;

    if (source.buffer) {
      const ext =
        type === 'image'
          ? '.jpg'
          : type === 'video'
            ? '.mp4'
            : type === 'audio'
              ? '.m4a'
              : '.bin';
      tempFile = path.join(
        process.env.TMPDIR || '/tmp',
        `nanoclaw-imsg-${Date.now()}${ext}`,
      );
      fs.writeFileSync(tempFile, source.buffer);
      filePath = tempFile;
    } else if (source.url) {
      try {
        const response = await fetch(source.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        const ext = path.extname(new URL(source.url).pathname) || '.bin';
        tempFile = path.join(
          process.env.TMPDIR || '/tmp',
          `nanoclaw-imsg-${Date.now()}${ext}`,
        );
        fs.writeFileSync(tempFile, buffer);
        filePath = tempFile;
      } catch (err) {
        logger.error({ jid, err }, 'Failed to download media for iMessage');
        return;
      }
    }

    if (!filePath) {
      logger.warn({ jid, type }, 'No media source for iMessage');
      return;
    }

    try {
      const args = ['send', '--chat-id', chatId, '--file', filePath];
      if (options?.caption) {
        const plain = renderMarkdown(options.caption, PlainTextRenderer);
        args.push('--text', `${DISPLAY_NAME}: ${plain}`);
      }
      await execFileAsync('imsg', args);
      logger.info({ jid, type }, 'iMessage media sent');
    } catch (err) {
      logger.error({ jid, type, err }, 'Failed to send iMessage media');
    } finally {
      if (tempFile) {
        try {
          fs.unlinkSync(tempFile);
        } catch {}
      }
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const chatId = jid.replace(/^imsg:/, '');
    try {
      await execFileAsync('imsg', [
        'typing',
        '--chat-id',
        chatId,
        '--duration',
        '5s',
      ]);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send iMessage typing indicator');
    }
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('imsg:');
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('iMessage channel disconnected');
  }
}
