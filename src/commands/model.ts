import { DEFAULT_MODEL_TIER } from '../config.js';
import { MODEL_TIERS, isModelTier } from '../model-tiers.js';
import { SlashCommand } from './types.js';

export const modelCommand: SlashCommand = {
  name: 'model',
  description:
    'Show or set the model tier. Usage: `/model` or `/model <fast|default|advanced|frontier>`',
  handler: async ({ args, getModel, setModel, reply }) => {
    const arg = args.trim().toLowerCase();
    if (!arg) {
      const override = getModel();
      const current = override ?? DEFAULT_MODEL_TIER;
      await reply(
        `Current model tier: \`${current}\`${override ? '' : ' (default)'}`,
      );
      return;
    }
    if (!isModelTier(arg)) {
      await reply(
        `Unknown model tier \`${arg}\`. Use ${MODEL_TIERS.map((tier) => `\`${tier}\``).join(', ')}.`,
      );
      return;
    }
    setModel(arg);
    await reply(
      `Model tier switched to \`${arg}\`. Takes effect next message.`,
    );
  },
};
