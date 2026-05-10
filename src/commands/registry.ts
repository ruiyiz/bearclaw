import { bgCommand } from './bg.js';
import { cancelCommand } from './cancel.js';
import { contextCommand } from './context.js';
import { effortCommand } from './effort.js';
import { jobsCommand } from './jobs.js';
import { mcpCommand } from './mcp.js';
import { modelCommand } from './model.js';
import { newCommand } from './new.js';
import { skillsCommand } from './skills.js';
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
  bgCommand,
  cancelCommand,
  contextCommand,
  effortCommand,
  helpCommand,
  jobsCommand,
  mcpCommand,
  modelCommand,
  newCommand,
  skillsCommand,
  statusCommand,
].sort((a, b) => a.name.localeCompare(b.name));

export const commandMap = new Map(commands.map((c) => [c.name, c]));
