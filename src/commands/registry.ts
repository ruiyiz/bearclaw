import { effortCommand } from './effort.js';
import { jobsCommand } from './jobs.js';
import { modelCommand } from './model.js';
import { newCommand } from './new.js';
import { statusCommand } from './status.js';
import { SlashCommand } from './types.js';

const helpCommand: SlashCommand = {
  name: 'help',
  description: 'List all available commands',
  handler: async ({ reply }) => {
    const lines = commands.map((c) => `\`/${c.name}\` — ${c.description}`);
    await reply('**Commands**\n\n' + lines.join('\n'));
  },
};

export const commands: SlashCommand[] = [
  effortCommand,
  helpCommand,
  jobsCommand,
  modelCommand,
  newCommand,
  statusCommand,
].sort((a, b) => a.name.localeCompare(b.name));

export const commandMap = new Map(commands.map((c) => [c.name, c]));
