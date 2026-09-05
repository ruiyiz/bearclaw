import { listSkills } from '../store/skills.js';
import { SlashCommand } from './types.js';

export const skillsCommand: SlashCommand = {
  name: 'skills',
  description: 'List installed agent skills',
  handler: async ({ reply }) => {
    const skills = listSkills();
    if (skills.length === 0) {
      await reply('No skills installed. Add one from the web admin.');
      return;
    }
    const lines = [`**Skills (${skills.length})**`, ''];
    for (const s of skills) {
      const desc =
        s.description.length > 100
          ? s.description.slice(0, 97) + '...'
          : s.description;
      lines.push(`• \`${s.name}\` — ${desc || '(no description)'}`);
    }
    await reply(lines.join('\n'));
  },
};
