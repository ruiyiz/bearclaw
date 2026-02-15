export type OnInboundMessage = (chatJid: string, msg: NewMessage) => void;
export type OnChatMetadata = (chatJid: string, timestamp: string, name?: string) => void;

export interface Channel {
  name: string;
  prefixAssistantName: boolean;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  ownsJid(jid: string): boolean;
  isConnected(): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
}

export interface ContainerConfig {
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface OdysseyConfig {
  interval: string; // "30m", "1h", "6h"
  model?: string; // optional model override (e.g., cheaper model for routine checks)
  quiet?: { start: string; end: string }; // e.g. { start: "23:00", end: "07:00" }
}

export interface EmailConfig {
  address: string;       // Gmail trigger address, e.g. "ruiyizhang+coco@gmail.com"
  interval?: string;     // Poll interval: "30m", "1h", etc. Default: "1h"
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  odyssey?: OdysseyConfig;
  email?: EmailConfig;
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
  context_mode: 'group' | 'isolated';
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
