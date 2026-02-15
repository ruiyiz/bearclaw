import { DISPLAY_NAME } from './config.js';
import { Channel } from './types.js';

export function findChannel(channels: Channel[], jid: string): Channel | undefined {
  return channels.find((ch) => ch.ownsJid(jid));
}

export function formatOutbound(channel: Channel, text: string): string {
  if (channel.prefixAssistantName) {
    return `${DISPLAY_NAME}: ${text.trimStart()}`;
  }
  return text.trimStart();
}
