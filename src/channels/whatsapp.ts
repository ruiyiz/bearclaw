import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  WASocket,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { DISPLAY_NAME, GROUPS_DIR, STORE_DIR } from '../config.js';
import { renderMarkdown, WhatsAppRenderer } from '../format.js';
import { getLastGroupSync, setLastGroupSync, storeChatMetadata, updateChatName } from '../db.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcribe.js';
import { Channel, MediaOptions, MediaSource, MediaType, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock: WASocket | null = null;
  private lidToPhoneMap: Record<string, string> = {};
  private groupSyncTimerStarted = false;
  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const waLogger = logger.child({ module: 'baileys' });
    waLogger.level = 'warn';

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, waLogger),
      },
      printQRInTerminal: false,
      logger: waLogger,
      browser: ['NanoClaw', 'Chrome', '1.0.0'],
    });

    this.sock.ev.on('connection.update', (update) => {
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
          this.sock = null;
          this.connect();
        } else {
          logger.info('Logged out. Run /setup to re-authenticate.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        logger.info('Connected to WhatsApp');

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock!.user) {
          const phoneUser = this.sock!.user.id.split(':')[0];
          const lidUser = this.sock!.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Sync group metadata on startup (respects 24h cache)
        this.syncMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        const chatJid = this.translateJid(rawJid);
        const timestamp = new Date(
          Number(msg.messageTimestamp) * 1000,
        ).toISOString();

        storeChatMetadata(chatJid, timestamp);

        const registeredGroups = this.opts.registeredGroups();
        if (registeredGroups[chatJid]) {
          const normalized = await this.normalizeMessage(msg, chatJid);
          if (normalized) {
            this.opts.onMessage(chatJid, normalized);
          }
        }
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.sock) return;
    try {
      const formatted = renderMarkdown(text, WhatsAppRenderer);
      const prefixed = `${DISPLAY_NAME}: ${formatted}`;
      await this.sock.sendMessage(jid, { text: prefixed });
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send message');
    }
  }

  async sendMedia(jid: string, type: MediaType, source: MediaSource, options?: MediaOptions): Promise<void> {
    if (!this.sock) return;
    try {
      const media = source.buffer || (source.url ? { url: source.url } : null);
      if (!media) {
        logger.error('No media source provided');
        return;
      }
      const caption = options?.caption;
      switch (type) {
        case 'image':
          await this.sock.sendMessage(jid, { image: media, caption });
          break;
        case 'document': {
          const mimetype = options?.mimetype || 'application/octet-stream';
          const fileName = options?.fileName || 'file';
          await this.sock.sendMessage(jid, { document: media, mimetype, fileName, caption });
          break;
        }
        case 'video':
          await this.sock.sendMessage(jid, { video: media, caption });
          break;
        case 'audio':
          await this.sock.sendMessage(jid, { audio: media, mimetype: options?.mimetype || 'audio/mpeg' });
          break;
      }
      logger.info({ jid, type }, 'WhatsApp media sent');
    } catch (err) {
      logger.error({ jid, type, err }, 'Failed to send WhatsApp media');
    }
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
  }

  isConnected(): boolean {
    return this.sock !== null;
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate(isTyping ? 'composing' : 'paused', jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  async syncMetadata(force = false): Promise<void> {
    if (!this.sock) return;

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
      const groups = await this.sock.groupFetchAllParticipating();

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

  private translateJid(jid: string): string {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];
    const phoneJid = this.lidToPhoneMap[lidUser];
    if (phoneJid) {
      logger.debug({ lidJid: jid, phoneJid }, 'Translated LID to phone JID');
      return phoneJid;
    }
    return jid;
  }

  private async normalizeMessage(
    msg: any,
    chatJid: string,
  ): Promise<NewMessage | null> {
    const hasUserContent =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage ||
      msg.message?.imageMessage ||
      msg.message?.videoMessage ||
      msg.message?.audioMessage ||
      msg.message?.documentMessage ||
      msg.message?.stickerMessage;

    if (!hasUserContent) {
      const msgTypes = msg.message ? Object.keys(msg.message) : [];
      logger.debug({ msgTypes }, 'Filtered out non-user message');
      return null;
    }

    const msgId = msg.key?.id || `wa_${Date.now()}`;
    let content = '';

    if (msg.message?.conversation || msg.message?.extendedTextMessage) {
      content = msg.message.conversation || msg.message.extendedTextMessage.text || '';
    } else if (msg.message?.imageMessage) {
      const caption = msg.message.imageMessage.caption ? ` ${msg.message.imageMessage.caption}` : '';
      const filePath = await this.downloadMedia(msg, chatJid, `photo-${msgId}`, '.jpg');
      content = filePath ? `[Photo: ${filePath}]${caption}` : `[Photo]${caption}`;
    } else if (msg.message?.videoMessage) {
      const caption = msg.message.videoMessage.caption ? ` ${msg.message.videoMessage.caption}` : '';
      const filePath = await this.downloadMedia(msg, chatJid, `video-${msgId}`, '.mp4');
      content = filePath ? `[Video: ${filePath}]${caption}` : `[Video]${caption}`;
    } else if (msg.message?.audioMessage?.ptt) {
      // Voice message (Push-to-Talk)
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        if (buffer) {
          const transcription = await transcribeAudio(buffer as Buffer, msgId);
          if (transcription) {
            content = `[Voice message] ${transcription}`;
            logger.info({ length: transcription.length }, 'Voice message transcribed');
          } else {
            content = '[Voice message - transcription failed]';
          }
        } else {
          content = '[Voice message - download failed]';
        }
      } catch (err) {
        content = '[Voice message - transcription error]';
        logger.error({ err }, 'Voice transcription error');
      }
    } else if (msg.message?.audioMessage) {
      const filePath = await this.downloadMedia(msg, chatJid, `audio-${msgId}`, '.ogg');
      content = filePath ? `[Audio: ${filePath}]` : '[Audio]';
    } else if (msg.message?.documentMessage) {
      const fileName = msg.message.documentMessage.fileName || 'file';
      const ext = path.extname(fileName) || '';
      const filePath = await this.downloadMedia(msg, chatJid, `doc-${msgId}`, ext);
      content = filePath ? `[Document: ${filePath}]` : `[Document: ${fileName}]`;
    } else if (msg.message?.stickerMessage) {
      content = '[Sticker]';
    }

    const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();
    const sender = msg.key.participant || msg.key.remoteJid || '';
    const senderName = msg.pushName || sender.split('@')[0];

    return {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
    };
  }

  private async downloadMedia(msg: any, chatJid: string, baseName: string, ext: string): Promise<string | null> {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      if (!buffer) return null;

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return null;

      const mediaDir = path.join(GROUPS_DIR, group.folder, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      const filePath = path.join(mediaDir, `${baseName}${ext}`);
      fs.writeFileSync(filePath, buffer as Buffer);
      logger.debug({ filePath }, 'WhatsApp media saved');
      return filePath;
    } catch (err) {
      logger.warn({ err }, 'Failed to download WhatsApp media');
      return null;
    }
  }
}
