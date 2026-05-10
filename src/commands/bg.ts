import { SlashCommand } from './types.js';

export const bgCommand: SlashCommand = {
  name: 'bg',
  description:
    'Run a prompt in the background; reply when done (fresh session, does not block this chat)',
  handler: async ({ args, reply, runInBackground }) => {
    const prompt = args.trim();
    if (!prompt) {
      await reply(
        'Usage: `/bg <prompt>`\n\nRuns the prompt in a fresh background session. Useful for slow tasks like image generation that would otherwise block this chat.',
      );
      return;
    }
    runInBackground(prompt);
    const preview = prompt.length > 100 ? prompt.slice(0, 100) + '…' : prompt;
    await reply(`🌀 Backgrounded — will reply when done.\n> ${preview}`);
  },
};
