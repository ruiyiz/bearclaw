import { SlashCommand } from './types.js';

export const newCommand: SlashCommand = {
  name: 'new',
  description: 'Clear session and start fresh (optionally pass a prompt)',
  handler: async ({ args, clearSession, reply }) => {
    clearSession();
    if (!args) {
      await reply('Session cleared! Starting fresh.');
      return;
    }
    return { continueAs: args };
  },
};
