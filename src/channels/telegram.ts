import fs from 'fs';
import path from 'path';

import { Api, Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcribe.js';
import { Channel, MediaOptions, MediaSource, MediaType, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';
  prefixAssistantName = false;

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate @bot_username mentions into TRIGGER_PATTERN format
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid, chatName }, 'Message from unregistered Telegram chat');
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
      });

      logger.info({ chatJid, chatName, sender: senderName }, 'Telegram message stored');
    });

    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);

      let content = `[Photo]${caption}`;
      try {
        const photos = ctx.message.photo;
        const fileId = photos[photos.length - 1].file_id;
        const file = await ctx.api.getFile(fileId);
        if (file.file_path) {
          const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
          const response = await fetch(url);
          if (response.ok) {
            const buffer = Buffer.from(await response.arrayBuffer());
            const ext = path.extname(file.file_path) || '.jpg';
            const mediaDir = path.join(GROUPS_DIR, group.folder, 'media');
            fs.mkdirSync(mediaDir, { recursive: true });
            const filename = `photo-${ctx.message.message_id}${ext}`;
            const filePath = path.join(mediaDir, filename);
            fs.writeFileSync(filePath, buffer);
            content = `[Photo: ${filePath}]${caption}`;
            logger.debug({ filePath }, 'Telegram photo saved');
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to download Telegram photo');
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
      });
    });
    this.bot.on('message:video', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);

      let content = `[Video]${caption}`;
      try {
        const fileId = ctx.message.video.file_id;
        const filePath = await this.downloadTelegramFile(fileId, group.folder, `video-${ctx.message.message_id}`, '.mp4');
        if (filePath) content = `[Video: ${filePath}]${caption}`;
      } catch (err) {
        logger.warn({ err }, 'Failed to download Telegram video');
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
      });
    });

    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';

      this.opts.onChatMetadata(chatJid, timestamp);

      let content = '[Voice message]';
      try {
        const fileId = ctx.message.voice.file_id;
        const buffer = await this.downloadTelegramFileBuffer(fileId);
        if (buffer) {
          const transcription = await transcribeAudio(buffer, `tg-voice-${ctx.message.message_id}`);
          if (transcription) {
            content = `[Voice message] ${transcription}`;
            logger.info({ length: transcription.length }, 'Telegram voice transcribed');
          } else {
            content = '[Voice message - transcription failed]';
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to transcribe Telegram voice');
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
      });
    });

    this.bot.on('message:audio', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);

      let content = `[Audio]${caption}`;
      try {
        const fileId = ctx.message.audio.file_id;
        const ext = path.extname(ctx.message.audio.file_name || '') || '.mp3';
        const filePath = await this.downloadTelegramFile(fileId, group.folder, `audio-${ctx.message.message_id}`, ext);
        if (filePath) content = `[Audio: ${filePath}]${caption}`;
      } catch (err) {
        logger.warn({ err }, 'Failed to download Telegram audio');
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
      });
    });

    this.bot.on('message:document', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const name = ctx.message.document?.file_name || 'file';

      this.opts.onChatMetadata(chatJid, timestamp);

      let content = `[Document: ${name}]${caption}`;
      try {
        const fileId = ctx.message.document.file_id;
        const ext = path.extname(name) || '';
        const filePath = await this.downloadTelegramFile(fileId, group.folder, `doc-${ctx.message.message_id}`, ext);
        if (filePath) content = `[Document: ${filePath}]${caption}`;
      } catch (err) {
        logger.warn({ err }, 'Failed to download Telegram document');
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
      });
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(`  Send /chatid to the bot to get a chat's registration ID\n`);
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendMedia(jid: string, type: MediaType, source: MediaSource, options?: MediaOptions): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const input = source.buffer
        ? new InputFile(source.buffer, options?.fileName)
        : source.url!;
      const caption = options?.caption;

      switch (type) {
        case 'image':
          await this.bot.api.sendPhoto(numericId, input, { caption });
          break;
        case 'document':
          await this.bot.api.sendDocument(numericId, input, { caption });
          break;
        case 'video':
          await this.bot.api.sendVideo(numericId, input, { caption });
          break;
        case 'audio':
          await this.bot.api.sendAudio(numericId, input, { caption });
          break;
      }
      logger.info({ jid, type }, 'Telegram media sent');
    } catch (err) {
      logger.error({ jid, type, err }, 'Failed to send Telegram media');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  async sendAsAgent(jid: string, text: string, agentName: string, groupFolder: string): Promise<void> {
    await sendPoolMessage(jid, text, agentName, groupFolder);
  }

  async sendMediaAsAgent(jid: string, type: MediaType, source: MediaSource, options: MediaOptions, agentName: string, groupFolder: string): Promise<void> {
    await sendPoolMessage(jid, '', agentName, groupFolder, { type, source, options });
  }

  private async downloadTelegramFileBuffer(fileId: string): Promise<Buffer | null> {
    if (!this.bot) return null;
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) return null;
    const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  }

  private async downloadTelegramFile(fileId: string, groupFolder: string, baseName: string, ext: string): Promise<string | null> {
    const buffer = await this.downloadTelegramFileBuffer(fileId);
    if (!buffer) return null;
    const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    const filePath = path.join(mediaDir, `${baseName}${ext}`);
    fs.writeFileSync(filePath, buffer);
    logger.debug({ filePath }, 'Telegram file saved');
    return filePath;
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
  media?: { type: MediaType; source: MediaSource; options?: MediaOptions },
): Promise<void> {
  if (poolApis.length === 0) return;

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info({ sender, groupFolder, poolIndex: idx }, 'Assigned and renamed pool bot');
    } catch (err) {
      logger.warn({ sender, err }, 'Failed to rename pool bot');
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');

    if (media) {
      const input = media.source.buffer
        ? new InputFile(media.source.buffer, media.options?.fileName)
        : media.source.url!;
      const caption = media.options?.caption;

      switch (media.type) {
        case 'image':
          await api.sendPhoto(numericId, input, { caption });
          break;
        case 'document':
          await api.sendDocument(numericId, input, { caption });
          break;
        case 'video':
          await api.sendVideo(numericId, input, { caption });
          break;
        case 'audio':
          await api.sendAudio(numericId, input, { caption });
          break;
      }
      logger.info({ chatId, sender, poolIndex: idx, type: media.type }, 'Pool media sent');
      return;
    }

    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await api.sendMessage(numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info({ chatId, sender, poolIndex: idx, length: text.length }, 'Pool message sent');
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

export function hasPoolBots(): boolean {
  return poolApis.length > 0;
}
