export type OnInboundMessage = (chatJid: string, msg: NewMessage) => void;
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
) => void;

export type MediaType = 'image' | 'document' | 'video' | 'audio';

export interface MediaSource {
  buffer?: Buffer;
  url?: string;
}

export interface MediaOptions {
  caption?: string;
  fileName?: string;
  mimetype?: string;
  ptt?: boolean;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  sendMessageWithId?(jid: string, text: string): Promise<number>;
  editMessage?(jid: string, messageId: number, text: string): Promise<void>;
  deleteMessage?(jid: string, messageId: number): Promise<void>;
  sendMedia?(
    jid: string,
    type: MediaType,
    source: MediaSource,
    options?: MediaOptions,
  ): Promise<void>;
  ownsJid(jid: string): boolean;
  isConnected(): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  reactToMessage?(jid: string, msgId: string, emoji: string): Promise<void>;
  sendAsAgent?(
    jid: string,
    text: string,
    agentName: string,
    agentFolder: string,
  ): Promise<void>;
  sendMediaAsAgent?(
    jid: string,
    type: MediaType,
    source: MediaSource,
    options: MediaOptions,
    agentName: string,
    agentFolder: string,
  ): Promise<void>;
  syncMetadata?(force?: boolean): Promise<void>;
}

interface ContainerConfig {
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface HeartbeatConfig {
  interval: string; // "30m", "1h", "6h"
  model?: string; // optional model override (e.g., cheaper model for routine checks)
  quiet?: { start: string; end: string }; // e.g. { start: "23:00", end: "07:00" }
}

interface EmailConfig {
  address: string; // Gmail trigger address, e.g. "ruiyizhang+coco@gmail.com"
  interval?: string; // Poll interval: "30m", "1h", etc. Default: "1h"
}

interface ActiveHoursConfig {
  cron: string | string[]; // one or more cron expressions (OR logic); e.g. ["* 18-22 * * 1-5", "* * * * 0,6"]
  autoReply?: string; // custom off-hours message
}

export interface RegisteredAgent {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  heartbeat?: HeartbeatConfig;
  email?: EmailConfig;
  activeHours?: ActiveHoursConfig;
  // Marks the channel that should receive folder-wide proactive messages
  // (e.g. the Hypnopompic Report) when multiple channels share the folder.
  primary?: boolean;
}

export interface Session {
  [folder: string]: string;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
}

export interface EmailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  body: string;
  date: string;
}

export interface EventRecord {
  id: number;
  type: string;
  payload: string; // JSON
  emitted_at: string;
  processed: number; // 0 or 1
}

export interface Handler {
  id: string;
  group_folder: string;
  prompt: string;
  context_mode: 'agent' | 'isolated';
  event_type: string;
  filter: string | null;
  cron: string | null;
  next_run: string | null;
  cooldown_ms: number;
  last_triggered: string | null;
  max_triggers: number | null;
  trigger_count: number;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface HandlerRunLog {
  handler_id: string;
  event_id: number;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}
