import fs from 'fs';
import path from 'path';

import { Api, Bot, InputFile } from 'grammy';

import { commands } from '../commands/registry.js';
import { formatStatus } from '../commands/status.js';
import { ASSISTANT_NAME, TRIGGER_PATTERN, agentVarDir } from '../config.js';
import {
  chunkMarkdownForChannel,
  PlainTextRenderer,
  renderMarkdown,
  TelegramHtmlRenderer,
} from '../media/format.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../media/transcribe.js';
import {
  Channel,
  MediaOptions,
  MediaSource,
  MediaType,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredAgent,
} from '../types.js';

interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredAgents: () => Record<string, RegisteredAgent>;
  // Inline-keyboard taps, e.g. a workflow human step answered with a button.
  onChoice?: (jid: string, data: string) => Promise<string | null>;
}

// PNGs sent via sendPhoto get recompressed to JPEG and capped at ~1280px,
// which destroys small text on canvas renders. Route them through sendDocument
// to preserve byte-for-byte quality. JPEGs (user-forwarded photos) still go
// through sendPhoto so they appear inline.
function isPng(buffer: Buffer | undefined): boolean {
  if (!buffer || buffer.length < 4) return false;
  return (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  );
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Bootstrap fast-path: lets unregistered chats discover their chat_jid
    // for agent registration. Registered chats normally hit /status via the
    // shared registry through opts.onMessage; this handler terminates the
    // middleware chain first when present, so the bootstrap output and the
    // registry output must stay in sync (both call formatStatus).
    this.bot.command('status', (ctx) => {
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';
      void this.sendMessage(
        `tg:${ctx.chat.id}`,
        formatStatus({
          chatJid: `tg:${ctx.chat.id}`,
          chatName,
          chatType,
        }),
      );
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

      const agent = this.opts.registeredAgents()[chatJid];
      if (!agent) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram agent',
        );
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

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const agent = this.opts.registeredAgents()[chatJid];
      if (!agent) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
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
      const agent = this.opts.registeredAgents()[chatJid];
      if (!agent) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
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
            const mediaDir = path.join(agentVarDir(agent.folder), 'media');
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
      const agent = this.opts.registeredAgents()[chatJid];
      if (!agent) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);

      let content = `[Video]${caption}`;
      try {
        const fileId = ctx.message.video.file_id;
        const filePath = await this.downloadTelegramFile(
          fileId,
          agent.folder,
          `video-${ctx.message.message_id}`,
          '.mp4',
        );
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
      const agent = this.opts.registeredAgents()[chatJid];
      if (!agent) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';

      this.opts.onChatMetadata(chatJid, timestamp);

      let content = '[Voice message]';
      try {
        const fileId = ctx.message.voice.file_id;
        const buffer = await this.downloadTelegramFileBuffer(fileId);
        if (buffer) {
          const transcription = await transcribeAudio(
            buffer,
            `tg-voice-${ctx.message.message_id}`,
          );
          if (transcription) {
            content = `[Voice message] ${transcription}`;
            logger.info(
              { length: transcription.length },
              'Telegram voice transcribed',
            );
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
      const agent = this.opts.registeredAgents()[chatJid];
      if (!agent) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);

      let content = `[Audio]${caption}`;
      try {
        const fileId = ctx.message.audio.file_id;
        const ext = path.extname(ctx.message.audio.file_name || '') || '.mp3';
        const filePath = await this.downloadTelegramFile(
          fileId,
          agent.folder,
          `audio-${ctx.message.message_id}`,
          ext,
        );
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
      const agent = this.opts.registeredAgents()[chatJid];
      if (!agent) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const name = ctx.message.document?.file_name || 'file';

      this.opts.onChatMetadata(chatJid, timestamp);

      let content = `[Document: ${name}]${caption}`;
      try {
        const fileId = ctx.message.document.file_id;
        const ext = path.extname(name) || '';
        const filePath = await this.downloadTelegramFile(
          fileId,
          agent.folder,
          `doc-${ctx.message.message_id}`,
          ext,
        );
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

    this.bot.on('callback_query:data', async (ctx) => {
      const jid = `tg:${ctx.chat?.id ?? ctx.from.id}`;
      let note: string | null = null;
      try {
        note =
          (await this.opts.onChoice?.(jid, ctx.callbackQuery.data)) ?? null;
      } catch (err) {
        logger.error({ err, jid }, 'Telegram choice handler failed');
      }
      await ctx.answerCallbackQuery({ text: note ?? 'Done' });
      try {
        // Drop the keyboard so the same answer cannot be tapped twice.
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      } catch {
        /* message may be too old to edit */
      }
    });

    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // start() only settles once polling stops, so onStart is what resolves a
    // successful connect. A rejected start (a bad token answers getMe with
    // HTTP 401) has to reject this promise too: left floating it would be an
    // unhandled rejection that kills the process, and connect() would never
    // return.
    return new Promise<void>((resolve, reject) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          void this.bot!.api.setMyCommands(
            commands
              .map((c) => ({ command: c.name, description: c.description }))
              .sort((a, b) => a.command.localeCompare(b.command)),
          ).catch((err) => {
            logger.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'Failed to set Telegram bot commands',
            );
          });
          resolve();
        },
      }).catch((err) => {
        this.bot = null;
        reject(err instanceof Error ? err : new Error(String(err)));
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
      const chunks = chunkMarkdownForChannel(
        text,
        MAX_LENGTH,
        TelegramHtmlRenderer,
        PlainTextRenderer,
      );
      for (const chunk of chunks) {
        await this.bot.api.sendMessage(numericId, chunk, {
          parse_mode: 'HTML',
        });
      }
      logger.info(
        {
          jid,
          chunks: chunks.length,
          length: chunks.reduce((n, c) => n + c.length, 0),
        },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendChoices(
    jid: string,
    text: string,
    choices: { label: string; data: string }[],
  ): Promise<void> {
    if (!this.bot) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendMessage(numericId, text, {
        reply_markup: {
          inline_keyboard: [
            choices.map((c) => ({ text: c.label, callback_data: c.data })),
          ],
        },
      });
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram choices');
      await this.sendMessage(jid, text);
    }
  }

  async sendMessageWithId(jid: string, text: string): Promise<number> {
    const numericId = jid.replace(/^tg:/, '');
    const msg = await this.bot!.api.sendMessage(numericId, text);
    return msg.message_id;
  }

  async editMessage(
    jid: string,
    messageId: number,
    text: string,
  ): Promise<void> {
    const MAX_LENGTH = 4096;
    const numericId = jid.replace(/^tg:/, '');
    try {
      const chunks = chunkMarkdownForChannel(
        text,
        MAX_LENGTH,
        TelegramHtmlRenderer,
        PlainTextRenderer,
      );
      // First chunk replaces the streaming placeholder; the rest follow as
      // new messages so the user sees a continuous reply.
      await this.bot!.api.editMessageText(numericId, messageId, chunks[0], {
        parse_mode: 'HTML',
      });
      for (let i = 1; i < chunks.length; i++) {
        await this.bot!.api.sendMessage(numericId, chunks[i], {
          parse_mode: 'HTML',
        });
      }
    } catch {
      // Ignore "message is not modified" and other transient edit errors
    }
  }

  async deleteMessage(jid: string, messageId: number): Promise<void> {
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot!.api.deleteMessage(numericId, messageId);
    } catch {
      // Ignore if already deleted or not found
    }
  }

  async sendMedia(
    jid: string,
    type: MediaType,
    source: MediaSource,
    options?: MediaOptions,
  ): Promise<void> {
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
          if (isPng(source.buffer)) {
            const docInput = source.buffer
              ? new InputFile(source.buffer, options?.fileName || 'canvas.png')
              : input;
            await this.bot.api.sendDocument(numericId, docInput, { caption });
          } else {
            await this.bot.api.sendPhoto(numericId, input, { caption });
          }
          break;
        case 'document':
          await this.bot.api.sendDocument(numericId, input, { caption });
          break;
        case 'video':
          await this.bot.api.sendVideo(numericId, input, { caption });
          break;
        case 'audio':
          if (options?.ptt) {
            await this.bot.api.sendVoice(numericId, input, { caption });
          } else {
            await this.bot.api.sendAudio(numericId, input, { caption });
          }
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

  async reactToMessage(
    jid: string,
    msgId: string,
    emoji: string,
  ): Promise<void> {
    if (!this.bot) return;
    try {
      const numericChatId = jid.replace(/^tg:/, '');
      const numericMsgId = parseInt(msgId, 10);
      if (isNaN(numericMsgId)) return;
      await this.bot.api.setMessageReaction(numericChatId, numericMsgId, [
        // grammy types this as the canonical Telegram reaction emoji union;
        // we accept any string at the channel boundary and trust callers.
        { type: 'emoji', emoji: emoji as never },
      ]);
      logger.debug({ jid, msgId, emoji }, 'Telegram reaction set');
    } catch (err) {
      logger.warn({ jid, msgId, emoji, err }, 'Telegram reaction failed');
    }
  }

  async sendAsAgent(
    jid: string,
    text: string,
    agentName: string,
    agentFolder: string,
  ): Promise<void> {
    await sendPoolMessage(jid, text, agentName, agentFolder);
  }

  async sendMediaAsAgent(
    jid: string,
    type: MediaType,
    source: MediaSource,
    options: MediaOptions,
    agentName: string,
    agentFolder: string,
  ): Promise<void> {
    await sendPoolMessage(jid, '', agentName, agentFolder, {
      type,
      source,
      options,
    });
  }

  private async downloadTelegramFileBuffer(
    fileId: string,
  ): Promise<Buffer | null> {
    if (!this.bot) return null;
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) return null;
    const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  }

  private async downloadTelegramFile(
    fileId: string,
    agentFolder: string,
    baseName: string,
    ext: string,
  ): Promise<string | null> {
    const buffer = await this.downloadTelegramFileBuffer(fileId);
    if (!buffer) return null;
    const mediaDir = path.join(agentVarDir(agentFolder), 'media');
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

// Just enough of a channel for the boot guard below to drive, so the guard can
// be tested without a bot on the other end of the wire.
export interface StartableChannel {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

// Telegram is optional; booting is not. A token pasted into the setup wizard
// can be wrong, and grammY reports that as a rejected start (HTTP 401) — which
// must not take the whole process down. Log the failure with the fix and tell
// the caller to carry on without the channel.
export async function startTelegramChannel(
  channel: StartableChannel,
  poolTokens: string[] = [],
): Promise<boolean> {
  try {
    await channel.connect();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Telegram channel failed to start, continuing without it — check TELEGRAM_BOT_TOKEN in Admin > Settings',
    );
    await channel.disconnect().catch(() => {});
    return false;
  }
  if (poolTokens.length > 0) {
    // initBotPool already swallows per-token failures; this is belt and braces
    // so a surprise there cannot abort the boot either.
    try {
      await initBotPool(poolTokens);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Telegram bot pool failed to start, continuing without it — check TELEGRAM_BOT_POOL in Admin > Settings',
      );
    }
  }
  return true;
}

async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  agentFolder: string,
  media?: { type: MediaType; source: MediaSource; options?: MediaOptions },
): Promise<void> {
  if (poolApis.length === 0) return;

  const key = `${agentFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, agentFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
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
          if (isPng(media.source.buffer)) {
            const docInput = media.source.buffer
              ? new InputFile(
                  media.source.buffer,
                  media.options?.fileName || 'canvas.png',
                )
              : input;
            await api.sendDocument(numericId, docInput, { caption });
          } else {
            await api.sendPhoto(numericId, input, { caption });
          }
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
      logger.info(
        { chatId, sender, poolIndex: idx, type: media.type },
        'Pool media sent',
      );
      return;
    }

    const formatted = renderMarkdown(text, TelegramHtmlRenderer);
    const MAX_LENGTH = 4096;
    if (formatted.length <= MAX_LENGTH) {
      await api.sendMessage(numericId, formatted, { parse_mode: 'HTML' });
    } else {
      for (let i = 0; i < formatted.length; i += MAX_LENGTH) {
        await api.sendMessage(numericId, formatted.slice(i, i + MAX_LENGTH), {
          parse_mode: 'HTML',
        });
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: formatted.length },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}
