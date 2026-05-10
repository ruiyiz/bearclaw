import { DEFAULT_EFFORT, EFFORT_LEVELS, EffortLevel } from '../agent/runner.js';
import { SlashCommand } from './types.js';

const ALIASES: Record<string, EffortLevel> = {
  l: 'low',
  m: 'medium',
  h: 'high',
  x: 'xhigh',
  xh: 'xhigh',
  max: 'max',
};

function normalize(input: string): EffortLevel | undefined {
  const v = input.toLowerCase();
  if ((EFFORT_LEVELS as string[]).includes(v)) return v as EffortLevel;
  return ALIASES[v];
}

export const effortCommand: SlashCommand = {
  name: 'effort',
  description:
    'Show or set thinking effort. Usage: `/effort` or `/effort low|medium|high|xhigh|max`.',
  handler: async ({ args, getEffort, setEffort, reply }) => {
    const arg = args.trim();
    if (!arg) {
      const override = getEffort();
      const current = override ?? DEFAULT_EFFORT;
      const suffix = override ? '' : ', default';
      await reply(`Current effort: \`${current}\`${suffix}`);
      return;
    }
    const target = normalize(arg);
    if (!target) {
      await reply(
        `Unknown effort \`${arg}\`. Use \`low\`, \`medium\`, \`high\`, \`xhigh\`, or \`max\`.`,
      );
      return;
    }
    setEffort(target);
    await reply(`Effort set to \`${target}\`. Takes effect next message.`);
  },
};
