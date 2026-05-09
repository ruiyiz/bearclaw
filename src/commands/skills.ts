import fs from 'fs';
import path from 'path';

import { SKILLS_DIR } from '../config.js';
import { SlashCommand } from './types.js';

interface SkillEntry {
  name: string;
  description: string;
}

function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function loadSkills(): SkillEntry[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const out: SkillEntry[] = [];
  for (const dir of fs.readdirSync(SKILLS_DIR)) {
    const skillFile = path.join(SKILLS_DIR, dir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const fm = parseFrontmatter(fs.readFileSync(skillFile, 'utf-8'));
    out.push({
      name: fm.name || dir,
      description: fm.description || '',
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const skillsCommand: SlashCommand = {
  name: 'skills',
  description: 'List installed agent skills',
  handler: async ({ reply }) => {
    const skills = loadSkills();
    if (skills.length === 0) {
      await reply(`No skills found in \`${SKILLS_DIR}\`.`);
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
