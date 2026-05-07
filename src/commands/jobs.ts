import { getAllHandlers } from '../db.js';
import { SlashCommand } from './types.js';

const STATUS_ORDER: Record<string, number> = {
  active: 0,
  paused: 1,
  completed: 2,
};

function formatJobsList(): string {
  const handlers = getAllHandlers()
    .filter((h) => h.cron)
    .sort((a, b) => {
      const sa = STATUS_ORDER[a.status] ?? 99;
      const sb = STATUS_ORDER[b.status] ?? 99;
      if (sa !== sb) return sa - sb;
      return a.id.localeCompare(b.id);
    });
  if (handlers.length === 0) return 'No scheduled jobs.';

  const lines = handlers.map((h) => {
    const promptPreview =
      h.prompt.length > 60 ? h.prompt.slice(0, 57) + '...' : h.prompt;
    const next = h.next_run ? h.next_run.replace('T', ' ').slice(0, 16) : '-';
    const flag =
      h.status === 'active' ? '●' : h.status === 'paused' ? '⏸' : '✓';
    return (
      `${flag} \`${h.id}\`\n` +
      `   ${h.group_folder} · \`${h.cron}\`\n` +
      `   next: ${next}\n` +
      `   ${promptPreview}`
    );
  });

  return `**Scheduled jobs (${handlers.length})**\n\n` + lines.join('\n\n');
}

export const jobsCommand: SlashCommand = {
  name: 'jobs',
  description: 'List all scheduled jobs (cron handlers)',
  handler: async ({ reply }) => {
    await reply(formatJobsList());
  },
};
