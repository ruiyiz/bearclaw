import { DEFAULT_MODEL } from '../agent/runner.js';
import { SlashCommand } from './types.js';

const MODEL_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  h: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
  s: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
  o: 'claude-opus-4-7',
};

function aliasForId(id: string): string {
  if (id.includes('haiku')) return 'haiku';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('opus')) return 'opus';
  return id;
}

export const modelCommand: SlashCommand = {
  name: 'model',
  description:
    'Show or set the agent model. Usage: `/model` (show) or `/model haiku|sonnet|opus`',
  handler: async ({ args, getModel, setModel, reply }) => {
    const arg = args.trim().toLowerCase();
    if (!arg) {
      const override = getModel();
      const current = override ?? DEFAULT_MODEL;
      const suffix = override
        ? aliasForId(current)
        : `${aliasForId(current)}, default`;
      await reply(`Current model: \`${current}\` (${suffix})`);
      return;
    }
    const target = MODEL_ALIASES[arg];
    if (!target) {
      await reply(
        `Unknown model \`${arg}\`. Use \`haiku\`, \`sonnet\`, or \`opus\`.`,
      );
      return;
    }
    setModel(target);
    await reply(`Model switched to \`${target}\`. Takes effect next message.`);
  },
};
