import { DEFAULT_MODEL } from '../agent/runner.js';
import { aliasForId, modelAliasList, resolveModelAlias } from '../models.js';
import { SlashCommand } from './types.js';

export const modelCommand: SlashCommand = {
  name: 'model',
  description:
    'Show or set the agent model. Usage: `/model` (show) or `/model <alias>`',
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
    const target = resolveModelAlias(arg);
    if (!target) {
      await reply(`Unknown model \`${arg}\`. Use ${modelAliasList()}.`);
      return;
    }
    setModel(target);
    await reply(`Model switched to \`${target}\`. Takes effect next message.`);
  },
};
