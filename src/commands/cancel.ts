import { SlashCommand } from './types.js';

export const cancelCommand: SlashCommand = {
  name: 'cancel',
  description: "Interrupt the agent's current turn (streaming-input mode)",
  handler: async ({ reply, interruptCurrent }) => {
    const ok = await interruptCurrent();
    await reply(ok ? '🛑 Interrupted.' : 'Nothing to interrupt.');
  },
};
