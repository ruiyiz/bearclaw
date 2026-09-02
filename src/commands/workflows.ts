import {
  getRun,
  getWorkflowRow,
  listOpenWaits,
  listRuns,
  listWorkflowRows,
} from '../workflows/db.js';
import { listTriggers, runManually } from '../workflows/triggers.js';
import { SlashCommand } from './types.js';

function shortTime(iso: string | null): string {
  return iso ? iso.replace('T', ' ').slice(0, 16) : '-';
}

function formatList(): string {
  const rows = listWorkflowRows();
  if (!rows.length) return 'No workflows.';
  const waits = listOpenWaits('human');
  const lines = rows.map((w) => {
    const triggers = listTriggers(w.slug);
    const next = triggers
      .filter((t) => t.enabled && t.next_run_at)
      .map((t) => t.next_run_at!)
      .sort()[0];
    const open = waits.filter((x) => getRun(x.run_id)?.slug === w.slug).length;
    const flag = w.enabled ? '●' : '⏸';
    return (
      `${flag} \`${w.slug}\` — ${w.name}\n` +
      `   ${w.owner} · ${triggers.map((t) => t.type).join(', ') || 'no triggers'}\n` +
      `   next: ${shortTime(next ?? null)} · last: ${w.last_status ?? 'never'}` +
      (open ? `\n   ${open} waiting on you` : '')
    );
  });
  return `**Workflows (${rows.length})**\n\n${lines.join('\n\n')}`;
}

function formatDetail(slug: string): string {
  const row = getWorkflowRow(slug);
  if (!row) return `No workflow \`${slug}\`.`;
  const triggers = listTriggers(slug).map(
    (t) =>
      `- ${t.type}${t.enabled ? '' : ' (paused)'} · ${t.source}` +
      (t.next_run_at ? ` · next ${shortTime(t.next_run_at)}` : ''),
  );
  const runs = listRuns(slug, 5).map(
    (r) =>
      `- ${r.status} · ${shortTime(r.started_at)}${r.error ? ` · ${r.error}` : ''}`,
  );
  return [
    `**${row.name}** (\`${row.slug}\`)`,
    `owner: ${row.owner}${row.enabled ? '' : ' · paused'}`,
    `nodes: ${Object.keys(row.definition.nodes ?? {}).join(', ')}`,
    '',
    '**Triggers**',
    triggers.length ? triggers.join('\n') : '- none',
    '',
    '**Recent runs**',
    runs.length ? runs.join('\n') : '- none',
  ].join('\n');
}

export const workflowsCommand: SlashCommand = {
  name: 'workflows',
  description: 'List workflows, show one, or run one (/workflows run <slug>)',
  handler: async ({ args, reply }) => {
    const [verb, slug] = args.trim().split(/\s+/);
    if (!verb) return void (await reply(formatList()));
    if (verb === 'run') {
      if (!slug) return void (await reply('Usage: /workflows run <slug>'));
      try {
        const result = await runManually(slug, {}, 'chat');
        const run = result.runId ? getRun(result.runId) : undefined;
        await reply(
          result.runId
            ? `Run ${result.runId} ${run?.status ?? result.status}${run?.error ? `\n${run.error}` : ''}`
            : `Run ${result.status}.`,
        );
      } catch (err) {
        await reply(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    await reply(formatDetail(verb));
  },
};
