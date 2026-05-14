import fs from 'fs';
import path from 'path';

import { webBroker } from '../server/broker.js';
import { agentVarDir } from '../config.js';
import { logger } from '../logger.js';
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

type OnOutboundMessage = (msg: NewMessage) => void;
type OnOutboundEdit = (id: string, chatJid: string, content: string) => void;
type OnOutboundDelete = (id: string, chatJid: string) => void;

interface WebChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredAgents: () => Record<string, RegisteredAgent>;
  onOutbound?: OnOutboundMessage;
  onOutboundEdit?: OnOutboundEdit;
  onOutboundDelete?: OnOutboundDelete;
}

// JID layout: `web:<folder>:<sessionId>` — folder picks the agent identity,
// sessionId picks one of the user's persistent conversation threads. Anything
// starting with `web:` is owned by this channel.
const WEB_JID_PREFIX = 'web:';

export function isWebJid(jid: string): boolean {
  return jid.startsWith(WEB_JID_PREFIX);
}

export function folderFromJid(jid: string): string {
  const rest = jid.slice(WEB_JID_PREFIX.length);
  const colon = rest.indexOf(':');
  return colon === -1 ? rest : rest.slice(0, colon);
}

export function sessionIdFromJid(jid: string): string | null {
  const rest = jid.slice(WEB_JID_PREFIX.length);
  const colon = rest.indexOf(':');
  return colon === -1 ? null : rest.slice(colon + 1);
}

export function webJid(folder: string, sessionId: string): string {
  return `${WEB_JID_PREFIX}${folder}:${sessionId}`;
}

const MEDIA_TYPE_TAG: Record<MediaType, string> = {
  image: 'Photo',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
};

export class WebChannel implements Channel {
  name = 'web';

  private opts: WebChannelOpts;
  private connected = false;
  private nextId = 1;
  // Tag added to persisted DB ids so a process restart with a fresh `nextId`
  // counter cannot collide with rows from a prior run.
  private idTag = Math.random().toString(36).slice(2, 8);

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

  private dbId(localId: number): string {
    return `web-out-${this.idTag}-${localId}`;
  }

  private agentName(jid: string): string {
    const folder = folderFromJid(jid);
    const reg = this.opts.registeredAgents()[jid];
    return reg?.name || folder;
  }

  private persistOutbound(
    jid: string,
    localId: number,
    content: string,
    timestamp: string,
  ): void {
    if (!this.opts.onOutbound) return;
    this.opts.onOutbound({
      id: this.dbId(localId),
      chat_jid: jid,
      sender: jid,
      sender_name: this.agentName(jid),
      content,
      timestamp,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const id = this.nextId++;
    const ts = Date.now();
    this.persistOutbound(jid, id, text, new Date(ts).toISOString());
    webBroker.publish(jid, { type: 'message', jid, id, text, ts });
  }

  async sendMessageWithId(jid: string, text: string): Promise<number> {
    const id = this.nextId++;
    const ts = Date.now();
    this.persistOutbound(jid, id, text, new Date(ts).toISOString());
    webBroker.publish(jid, { type: 'message', jid, id, text, ts });
    return id;
  }

  async editMessage(
    jid: string,
    messageId: number,
    text: string,
  ): Promise<void> {
    this.opts.onOutboundEdit?.(this.dbId(messageId), jid, text);
    webBroker.publish(jid, {
      type: 'edit',
      jid,
      id: messageId,
      text,
      ts: Date.now(),
    });
  }

  async deleteMessage(jid: string, messageId: number): Promise<void> {
    this.opts.onOutboundDelete?.(this.dbId(messageId), jid);
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
    const folder = folderFromJid(jid);
    const ts = Date.now();
    // Persist buffer-backed media into the agent's media dir so it shows up
    // for replay alongside inbound uploads. URL-backed sources pass through.
    let url = source.url;
    let absPath: string | null = null;
    if (source.buffer) {
      const ext = guessExt(type, options?.mimetype);
      const file = `web-out-${ts}-${id}${ext}`;
      const outDir = path.join(agentVarDir(folder), 'media');
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, file);
      fs.writeFileSync(outPath, source.buffer);
      absPath = outPath;
      url = `/api/user/agent-media?folder=${encodeURIComponent(folder)}&path=${encodeURIComponent(outPath)}`;
    } else if (
      source.url &&
      source.url.startsWith('/') &&
      fs.existsSync(source.url)
    ) {
      absPath = source.url;
    }

    if (absPath) {
      const captionPart = options?.caption ? ` ${options.caption}` : '';
      const tag = MEDIA_TYPE_TAG[type];
      const content = `[${tag}: ${absPath}]${captionPart}`;
      this.persistOutbound(jid, id, content, new Date(ts).toISOString());
    }

    webBroker.publish(jid, {
      type: 'media',
      jid,
      id,
      mediaType: type,
      caption: options?.caption,
      url,
      ts,
    });
  }

  // Inbound — called by the HTTP /api/user/chat handler. Stores chat metadata
  // and dispatches the message through the same callback the other channels
  // use so the runner's queue + session logic stays untouched.
  ingest(jid: string, text: string, senderName = 'You'): void {
    const timestamp = new Date().toISOString();
    this.opts.onChatMetadata(jid, timestamp, folderFromJid(jid));
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
