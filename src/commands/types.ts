import { NewMessage, RegisteredAgent } from '../types.js';

export interface SlashContext {
  args: string;
  agent: RegisteredAgent;
  chatJid: string;
  msg: NewMessage;
  reply: (text: string) => Promise<void>;
  clearSession: () => void;
  getSessionId: () => string | undefined;
  getModel: () => string | undefined;
  setModel: (model: string) => void;
  getEffort: () => string | undefined;
  setEffort: (effort: string) => void;
  runInBackground: (prompt: string) => void;
}

export interface SlashResult {
  // If set, router stops command flow and resumes normal agent dispatch
  // using this string as the message content. Use for commands that act
  // as a prefix (e.g. /new <prompt>).
  continueAs?: string;
}

export interface SlashCommand {
  name: string;
  description: string;
  handler: (ctx: SlashContext) => Promise<SlashResult | void>;
}
