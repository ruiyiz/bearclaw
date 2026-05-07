import { ASSISTANT_NAME } from '../config.js';
import { SlashCommand } from './types.js';

export interface StatusInfo {
  chatJid: string;
  chatName?: string;
  chatType?: string;
}

export function formatStatus(info: StatusInfo): string {
  const lines = [`${ASSISTANT_NAME} is online.`];
  lines.push(`Chat ID: \`${info.chatJid}\``);
  if (info.chatName) lines.push(`Name: ${info.chatName}`);
  if (info.chatType) lines.push(`Type: ${info.chatType}`);
  return lines.join('\n');
}

export const statusCommand: SlashCommand = {
  name: 'status',
  description: `Check ${ASSISTANT_NAME} liveness and show this chat's ID`,
  handler: async ({ chatJid, reply }) => {
    await reply(formatStatus({ chatJid }));
  },
};
