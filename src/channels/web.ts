import fs from 'fs';
import path from 'path';

import { webBroker } from '../server/broker.js';
import { CACHE_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  MediaOptions,
  MediaSource,
  MediaType,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredAgent,
} from '../types.js';

interface WebChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredAgents: () => Record<string, RegisteredAgent>;
}

// JID prefix used by the web channel. Each registered agent gets one JID per
// "session" — currently a single shared session per folder under web:<folder>.
const WEB_JID_PREFIX = 'web:';

export function isWebJid(jid: string): boolean {
  return jid.startsWith(WEB_JID_PREFIX);
}

export class WebChannel implements Channel {
  name = 'web';

  private opts: WebChannelOpts;
  private connected = false;
  private nextId = 1;

  constructor(opts: WebChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.connected = true;
    logger.info('Web channel ready');
  }

  ownsJid(jid: string): boolean {
    return isWebJid(jid);
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const id = this.nextId++;
    webBroker.publish(jid, { type: 'message', jid, id, text });
  }

  async sendMessageWithId(jid: string, text: string): Promise<number> {
    const id = this.nextId++;
    webBroker.publish(jid, { type: 'message', jid, id, text });
    return id;
  }

  async editMessage(
    jid: string,
    messageId: number,
    text: string,
  ): Promise<void> {
    webBroker.publish(jid, { type: 'edit', jid, id: messageId, text });
  }

  async deleteMessage(jid: string, messageId: number): Promise<void> {
    webBroker.publish(jid, { type: 'delete', jid, id: messageId });
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    webBroker.publish(jid, { type: 'typing', jid, isTyping });
  }

  async sendMedia(
    jid: string,
    type: MediaType,
    source: MediaSource,
    options?: MediaOptions,
  ): Promise<void> {
    const id = this.nextId++;
    // Persist to cache dir + emit URL when buffer-backed; pass URL through
    // unchanged otherwise.
    let url = source.url;
    if (source.buffer) {
      const ext = guessExt(type, options?.mimetype);
      const file = `web-${Date.now()}-${id}${ext}`;
      const outDir = path.join(CACHE_DIR, 'web-media');
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, file);
      fs.writeFileSync(outPath, source.buffer);
      url = `/api/media/${encodeURIComponent(file)}`;
    }
    webBroker.publish(jid, {
      type: 'media',
      jid,
      id,
      mediaType: type,
      caption: options?.caption,
      url,
    });
  }

  // Inbound — called by the HTTP /api/user/chat handler. Stores chat metadata
  // and dispatches the message through the same callback the other channels
  // use so the runner's queue + session logic stays untouched.
  ingest(jid: string, text: string, senderName = 'You'): void {
    const timestamp = new Date().toISOString();
    this.opts.onChatMetadata(jid, timestamp, jid.slice(WEB_JID_PREFIX.length));
    this.opts.onMessage(jid, {
      id: `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: jid,
      sender: jid,
      sender_name: senderName,
      content: text,
      timestamp,
    });
  }
}

function guessExt(type: MediaType, mimetype?: string): string {
  if (mimetype) {
    if (mimetype.includes('png')) return '.png';
    if (mimetype.includes('jpeg') || mimetype.includes('jpg')) return '.jpg';
    if (mimetype.includes('gif')) return '.gif';
    if (mimetype.includes('webp')) return '.webp';
    if (mimetype.includes('mp4')) return '.mp4';
    if (mimetype.includes('ogg')) return '.ogg';
    if (mimetype.includes('pdf')) return '.pdf';
  }
  switch (type) {
    case 'image':
      return '.png';
    case 'video':
      return '.mp4';
    case 'audio':
      return '.ogg';
    case 'document':
      return '.bin';
  }
}
