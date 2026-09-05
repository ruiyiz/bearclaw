import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { logger } from '../logger.js';
import {
  getRun,
  getWorkflowRow,
  listRuns,
  listSteps,
  listOpenWaits,
  listWorkflowRows,
  setWorkflowEnabled,
} from '../workflows/db.js';
import { cancelRun, resolveWait } from '../workflows/engine.js';
import { advise, formatIssue } from '../workflows/checks.js';
import { WorkflowValidationError } from '../workflows/schema.js';
import { deleteWorkflow, saveWorkflowDefinition } from '../workflows/store.js';
import {
  TriggerError,
  createTrigger,
  deleteTrigger,
  listTriggers,
  runManually,
  setTriggerEnabled,
} from '../workflows/triggers.js';

interface WorkflowToolContext {
  agentFolder: string;
  isMain: boolean;
  chatJid: string;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function describe(e: unknown): string {
  if (e instanceof WorkflowValidationError)
    return `${e.message}: ${e.issues.join('; ')}`;
  return e instanceof Error ? e.message : String(e);
}

// Non-main agents only reach workflows they own.
function assertOwnership(
  ctx: WorkflowToolContext,
  owner: string,
): string | null {
  if (ctx.isMain || owner === ctx.agentFolder) return null;
  return `Workflow is owned by "${owner}". You can only manage your own workflows.`;
}

export function createWorkflowTools(ctx: WorkflowToolContext) {
  return [
    tool(
      'workflow_list',
      `List workflows with their tags, triggers, next run, last status and open human waits.
A workflow is a small flowchart of typed nodes stored in the config database.`,
      {
        slug: z
          .string()
          .optional()
          .describe('Limit the listing to one workflow'),
        tag: z
          .string()
          .optional()
          .describe('Limit the listing to workflows carrying this tag'),
      },
      async (args) => {
        const tag = args.tag?.trim().toLowerCase();
        const rows = listWorkflowRows().filter(
          (w) =>
            (!args.slug || w.slug === args.slug) &&
            (!tag || (w.definition.tags ?? []).includes(tag)),
        );
        if (!rows.length)
          return ok(tag ? `No workflows tagged "${tag}".` : 'No workflows.');
        const waits = listOpenWaits('human');
        const lines = rows.map((w) => {
          const triggers = listTriggers(w.slug)
            .map(
              (t) =>
                `${t.type}${t.enabled ? '' : ' (paused)'}${
                  t.next_run_at ? ` next ${t.next_run_at}` : ''
                }`,
            )
            .join(', ');
          const open = waits.filter(
            (x) => getRun(x.run_id)?.slug === w.slug,
          ).length;
          const tags = w.definition.tags ?? [];
          return [
            `${w.slug} — ${w.name} [owner ${w.owner}${w.enabled ? '' : ', disabled'}]`,
            `  tags: ${tags.length ? tags.join(', ') : 'none'}`,
            `  nodes: ${Object.keys(w.definition.nodes ?? {}).join(', ')}`,
            `  triggers: ${triggers || 'none'}`,
            `  last: ${w.last_status ?? 'never run'}${open ? ` · ${open} waiting on a human` : ''}`,
          ].join('\n');
        });
        return ok(lines.join('\n\n'));
      },
    ),

    tool(
      'workflow_upsert',
      `Create or replace a workflow definition. Pass the full JSON definition.

Shape: { name, slug, owner, tags?, inputs?, triggers?, policies?, nodes, edges }
Node types: agent, shell, http, template, transform, condition, switch, send, human, wait_event, emit, delay.
Edges leave a named port: success/error by default, true/false on condition, the case labels on switch,
approved/rejected/submitted/timeout on human, received/timeout on wait_event.
Templates use {{ }} over { inputs, nodes, trigger, run, env }.`,
      {
        definition: z
          .record(z.string(), z.unknown())
          .describe('The complete workflow definition object'),
      },
      async (args) => {
        const owner = String(
          (args.definition as { owner?: unknown }).owner ?? ctx.agentFolder,
        );
        const denied = assertOwnership(ctx, owner);
        if (denied) return err(denied);
        try {
          const def = saveWorkflowDefinition({
            ...(args.definition as Record<string, unknown>),
            owner,
          } as never);
          // Saved, but say what is questionable about it: the author is
          // usually an agent that can fix it in the same turn.
          const notes = advise(def);
          return ok(
            [
              `Workflow "${def.slug}" saved with ${Object.keys(def.nodes).length} nodes and ${def.triggers.length} declared triggers.`,
              notes.length
                ? `\n${notes.length} thing${notes.length === 1 ? '' : 's'} to look at:\n${notes
                    .map((i) => `- ${formatIssue(i)}`)
                    .join('\n')}`
                : null,
            ]
              .filter(Boolean)
              .join('\n'),
          );
        } catch (e) {
          return err(describe(e));
        }
      },
    ),

    tool(
      'workflow_delete',
      'Delete a workflow definition.',
      { slug: z.string() },
      async (args) => {
        const row = getWorkflowRow(args.slug);
        if (!row) return err(`Unknown workflow: ${args.slug}`);
        const denied = assertOwnership(ctx, row.owner);
        if (denied) return err(denied);
        deleteWorkflow(args.slug);
        return ok(`Workflow "${args.slug}" deleted.`);
      },
    ),

    tool(
      'workflow_run',
      'Start a run now. Inputs are validated against the workflow inputs schema.',
      {
        slug: z.string(),
        inputs: z.record(z.string(), z.unknown()).default({}),
      },
      async (args) => {
        const row = getWorkflowRow(args.slug);
        if (!row) return err(`Unknown workflow: ${args.slug}`);
        try {
          const result = await runManually(
            args.slug,
            args.inputs,
            ctx.agentFolder,
          );
          if (!result.runId) return ok(`Run ${result.status}.`);
          const run = getRun(result.runId);
          const steps = listSteps(result.runId);
          return ok(
            `Run ${result.runId} is ${run?.status}. Steps: ${
              steps.map((s) => `${s.node_id}=${s.status}`).join(', ') || 'none'
            }${run?.error ? `\nError: ${run.error}` : ''}`,
          );
        } catch (e) {
          return err(describe(e));
        }
      },
    ),

    tool(
      'workflow_set_enabled',
      'Pause or resume a whole workflow. Individual triggers use trigger_set_enabled.',
      { slug: z.string(), enabled: z.boolean() },
      async (args) => {
        const row = getWorkflowRow(args.slug);
        if (!row) return err(`Unknown workflow: ${args.slug}`);
        const denied = assertOwnership(ctx, row.owner);
        if (denied) return err(denied);
        setWorkflowEnabled(args.slug, args.enabled);
        return ok(
          `Workflow "${args.slug}" ${args.enabled ? 'enabled' : 'paused'}.`,
        );
      },
    ),

    tool(
      'workflow_runs',
      'Recent runs, newest first, with status and failing node.',
      {
        slug: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
      async (args) => {
        const runs = listRuns(args.slug, args.limit);
        if (!runs.length) return ok('No runs.');
        return ok(
          runs
            .map(
              (r) =>
                `${r.id} ${r.slug} ${r.status} started ${r.started_at}${r.error ? ` — ${r.error}` : ''}`,
            )
            .join('\n'),
        );
      },
    ),

    tool(
      'workflow_respond',
      `Resolve a human step on the user's behalf. Use it when the user answers a pending question in chat.
Find the wait id with workflow_waits.`,
      {
        wait_id: z.string(),
        response: z
          .unknown()
          .describe(
            'true/false for an approval, the chosen label for a choice, or an object for an input form',
          ),
      },
      async (args) => {
        try {
          await resolveWait(
            args.wait_id,
            args.response,
            ctx.chatJid || ctx.agentFolder,
            'agent',
          );
          return ok(`Wait ${args.wait_id} resolved.`);
        } catch (e) {
          return err(describe(e));
        }
      },
    ),

    tool(
      'workflow_waits',
      'Open human steps across all workflows, with their prompt and options.',
      {},
      async () => {
        const waits = listOpenWaits('human');
        if (!waits.length) return ok('Nothing is waiting on a human.');
        return ok(
          waits
            .map((w) => {
              const run = getRun(w.run_id);
              return `${w.id} · ${run?.slug ?? '?'} / ${w.node_id}\n  ${w.prompt ?? ''}${
                w.options?.length ? `\n  options: ${w.options.join(', ')}` : ''
              }\n  expires ${w.resume_at ?? 'never'}`;
            })
            .join('\n\n'),
        );
      },
    ),

    tool(
      'run_cancel',
      'Cancel a run that is still going or waiting.',
      { run_id: z.string(), reason: z.string().optional() },
      async (args) => {
        const run = getRun(args.run_id);
        if (!run) return err(`Unknown run: ${args.run_id}`);
        await cancelRun(args.run_id, args.reason ?? 'cancelled by agent');
        return ok(`Run ${args.run_id} cancelled.`);
      },
    ),

    tool(
      'trigger_create',
      `Bind a firing condition to a workflow.

cron    — config { cron, timezone?, quiet?: {start,end}, catchup?: skip|once|all }
at      — config { at } for a one-shot; the trigger disables itself after firing
event   — config { event, filter?, map? } where map copies payload paths into inputs
webhook — no config; the token is returned once
manual  — no config

Reminders: create an "at" trigger on the built-in "reminder" workflow with args { text, to }
instead of writing a new workflow.`,
      {
        slug: z.string(),
        type: z.enum(['cron', 'event', 'manual', 'webhook', 'at']),
        config: z.record(z.string(), z.unknown()).default({}),
        args: z
          .record(z.string(), z.unknown())
          .default({})
          .describe(
            "Inputs for the run, validated against the workflow's inputs schema",
          ),
      },
      async (args) => {
        const row = getWorkflowRow(args.slug);
        if (!row) return err(`Unknown workflow: ${args.slug}`);
        const denied = assertOwnership(ctx, row.owner);
        if (denied) return err(denied);
        try {
          const trigger = createTrigger({
            slug: args.slug,
            type: args.type,
            config: args.config,
            args: args.args,
            createdBy: ctx.agentFolder,
          });
          const token = trigger.config.token as string | undefined;
          return ok(
            `Trigger ${trigger.id} created (${trigger.type})${
              trigger.next_run_at ? `, next fire ${trigger.next_run_at}` : ''
            }${token ? `\nWebhook token (shown once): ${token}` : ''}`,
          );
        } catch (e) {
          if (e instanceof TriggerError) return err(e.message);
          return err(describe(e));
        }
      },
    ),

    tool(
      'trigger_list',
      'Every trigger across workflows with source, next fire time and last run.',
      { slug: z.string().optional() },
      async (args) => {
        const rows = listTriggers(args.slug);
        if (!rows.length) return ok('No triggers.');
        return ok(
          rows
            .map(
              (t) =>
                `${t.id} · ${t.slug} · ${t.type} · ${t.source}${
                  t.enabled ? '' : ' · paused'
                }${t.next_run_at ? ` · next ${t.next_run_at}` : ''}${
                  t.last_fired_at ? ` · last ${t.last_fired_at}` : ''
                }${
                  Object.keys(t.args).length
                    ? `\n  args: ${JSON.stringify(t.args)}`
                    : ''
                }`,
            )
            .join('\n'),
        );
      },
    ),

    tool(
      'trigger_set_enabled',
      'Pause or resume one trigger. File-declared triggers can be paused but not deleted.',
      { id: z.string(), enabled: z.boolean() },
      async (args) => {
        try {
          setTriggerEnabled(args.id, args.enabled);
          return ok(
            `Trigger ${args.id} ${args.enabled ? 'enabled' : 'paused'}.`,
          );
        } catch (e) {
          return err(describe(e));
        }
      },
    ),

    tool(
      'trigger_delete',
      'Remove a runtime trigger. Triggers declared in a workflow file live in the file.',
      { id: z.string() },
      async (args) => {
        try {
          deleteTrigger(args.id);
          return ok(`Trigger ${args.id} deleted.`);
        } catch (e) {
          if (e instanceof TriggerError) return err(e.message);
          logger.error({ err: e }, 'trigger_delete failed');
          return err(describe(e));
        }
      },
    ),
  ];
}
