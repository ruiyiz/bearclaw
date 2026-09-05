import { CronExpressionParser } from 'cron-parser';
import { createHash, randomBytes } from 'node:crypto';

import { TIMEZONE } from '../config.js';
import { getUnprocessedEvents, markEventProcessed } from '../db.js';
import { logger } from '../logger.js';
import type { EventRecord } from '../types.js';
import {
  getRun,
  listWorkflowRows,
  deleteFileTriggersExcept,
  deleteTriggerRow,
  getTriggerRow,
  getWorkflowRow,
  listDueTriggerRows,
  listTriggerRows,
  listTriggerRowsByType,
  newId,
  updateTriggerRow,
  upsertTrigger,
  type TriggerRow,
  type TriggerType,
} from './db.js';
import {
  applyInputs,
  sendAlert,
  startRun,
  type StartRunResult,
} from './engine.js';
import { getEngineDeps } from './engine.js';
import { parseDuration } from './expr.js';
import type { TriggerDecl, WorkflowDefinition } from './schema.js';

const MAX_CATCHUP_SLOTS = 24;

export class TriggerError extends Error {}

function nowDate(): Date {
  return getEngineDeps().now();
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function nextCronRun(
  expr: string,
  from: Date,
  timezone = TIMEZONE,
): string {
  return CronExpressionParser.parse(expr, { tz: timezone, currentDate: from })
    .next()
    .toDate()
    .toISOString();
}

function inQuietWindow(
  quiet: { start: string; end: string } | undefined,
  at: Date,
  timezone: string,
): boolean {
  if (!quiet) return false;
  const local = new Date(at.toLocaleString('en-US', { timeZone: timezone }));
  const minutes = local.getHours() * 60 + local.getMinutes();
  const [sh, sm] = quiet.start.split(':').map(Number);
  const [eh, em] = quiet.end.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  return start <= end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

// ─── declaration and creation ───────────────────────────────────────────────

// File-declared triggers are owned by the loader: rewritten on every reload and
// deleted when they disappear from the file. Runtime triggers are never touched.
export function syncFileTriggers(def: WorkflowDefinition): void {
  const keep: string[] = [];
  for (const decl of def.triggers) {
    const id = `${def.slug}:${decl.id}`;
    keep.push(id);
    const existing = getTriggerRow(id);
    upsertTrigger({
      id,
      slug: def.slug,
      type: decl.type,
      source: 'file',
      config: configFromDecl(decl),
      args: decl.args ?? {},
      enabled: existing ? existing.enabled : decl.enabled,
      next_run_at: nextRunFor(decl.type, configFromDecl(decl), existing),
    });
  }
  const removed = deleteFileTriggersExcept(def.slug, keep);
  if (removed.length)
    logger.info({ slug: def.slug, removed }, 'workflow: file triggers removed');
}

function configFromDecl(decl: TriggerDecl): Record<string, unknown> {
  switch (decl.type) {
    case 'cron':
      return {
        cron: decl.cron,
        timezone: decl.timezone ?? TIMEZONE,
        quiet: decl.quiet,
        catchup: decl.catchup,
      };
    case 'event':
      return { event: decl.event, filter: decl.filter, map: decl.map };
    case 'at':
      return { at: decl.at };
    default:
      return {};
  }
}

function nextRunFor(
  type: TriggerType,
  config: Record<string, unknown>,
  existing?: TriggerRow,
): string | null {
  if (type === 'cron') {
    const expr = String(config.cron ?? '');
    if (!expr) return null;
    // Keep a pending slot so a reload does not skip the next firing.
    if (existing?.next_run_at && existing.next_run_at > nowDate().toISOString())
      return existing.next_run_at;
    return nextCronRun(expr, nowDate(), String(config.timezone ?? TIMEZONE));
  }
  if (type === 'at') return (config.at as string) ?? null;
  return null;
}

export interface CreateTriggerInput {
  slug: string;
  type: TriggerType;
  config?: Record<string, unknown>;
  args?: Record<string, unknown>;
  enabled?: boolean;
  createdBy?: string;
  id?: string;
}

export function createTrigger(input: CreateTriggerInput): TriggerRow {
  const workflow = getWorkflowRow(input.slug);
  if (!workflow) throw new TriggerError(`unknown workflow: ${input.slug}`);

  const config = { ...(input.config ?? {}) };
  if (input.type === 'cron') {
    if (!config.cron) throw new TriggerError('cron trigger needs a cron field');
    config.timezone ??= TIMEZONE;
    config.catchup ??= 'skip';
    nextCronRun(String(config.cron), nowDate(), String(config.timezone));
  }
  if (input.type === 'at') {
    if (!config.at) throw new TriggerError('at trigger needs an at field');
    if (Number.isNaN(new Date(String(config.at)).getTime()))
      throw new TriggerError(`invalid at: ${config.at}`);
  }
  if (input.type === 'event' && !config.event)
    throw new TriggerError('event trigger needs an event field');

  // Args are validated against the workflow's inputs schema before the row is
  // written, so a bad trigger fails at creation rather than at 3am.
  const args = applyInputs(workflow.definition, input.args ?? {});

  let token: string | undefined;
  if (input.type === 'webhook') {
    token = randomBytes(24).toString('base64url');
    config.token_hash = hashToken(token);
  }

  const id = input.id ?? newId('trg');
  upsertTrigger({
    id,
    slug: input.slug,
    type: input.type,
    source: 'runtime',
    config,
    args,
    enabled: input.enabled ?? true,
    next_run_at: nextRunFor(input.type, config),
    created_by: input.createdBy ?? null,
  });
  const row = getTriggerRow(id)!;
  return token
    ? ({ ...row, config: { ...row.config, token } } as TriggerRow)
    : row;
}

export function listTriggers(slug?: string): TriggerRow[] {
  return listTriggerRows(slug);
}

export function setTriggerEnabled(id: string, enabled: boolean): void {
  const trigger = getTriggerRow(id);
  if (!trigger) throw new TriggerError(`unknown trigger: ${id}`);
  const patch: Parameters<typeof updateTriggerRow>[1] = { enabled };
  if (enabled && trigger.type === 'cron' && !trigger.next_run_at)
    patch.next_run_at = nextRunFor(trigger.type, trigger.config);
  updateTriggerRow(id, patch);
}

export function deleteTrigger(id: string): void {
  const trigger = getTriggerRow(id);
  if (!trigger) return;
  if (trigger.source === 'file')
    throw new TriggerError(
      `trigger ${id} is declared by the workflow; edit the definition instead`,
    );
  deleteTriggerRow(id);
}

// ─── firing ─────────────────────────────────────────────────────────────────

function readPath(source: unknown, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === 'object'
          ? (acc as Record<string, unknown>)[key]
          : undefined,
      source,
    );
}

export async function fireTrigger(
  trigger: TriggerRow,
  payload?: unknown,
  runKey?: string,
): Promise<StartRunResult> {
  const workflow = getWorkflowRow(trigger.slug);
  if (!workflow) {
    // Orphaned row: disable it rather than throwing on every scan.
    updateTriggerRow(trigger.id, { enabled: false, next_run_at: null });
    logger.warn(
      { trigger: trigger.id, slug: trigger.slug },
      'workflow: trigger disabled, its workflow is gone',
    );
    return { runId: null, status: 'skipped' };
  }
  if (!workflow.enabled) return { runId: null, status: 'skipped' };

  const mapped: Record<string, unknown> = { ...trigger.args };
  const map = trigger.config.map as Record<string, string> | undefined;
  if (map && payload)
    for (const [field, path] of Object.entries(map))
      mapped[field] = readPath(payload, path);

  const result = await startRun({
    slug: trigger.slug,
    definition: workflow.definition,
    inputs: mapped,
    triggerId: trigger.id,
    triggerType: trigger.type,
    triggerPayload: payload,
    runKey,
  });

  updateTriggerRow(trigger.id, {
    last_fired_at: nowDate().toISOString(),
    last_run_id: result.runId,
  });
  return result;
}

// ─── scans ──────────────────────────────────────────────────────────────────

// Cron and one-shot rows fire off next_run_at. A missed slot is governed by the
// catch-up policy: skip forward, run once, or run every missed slot.
export async function scanDueTriggers(): Promise<void> {
  const now = nowDate();
  for (const trigger of listDueTriggerRows(now.toISOString())) {
    try {
      await fireDueTrigger(trigger, now);
    } catch (err) {
      logger.error(
        { err, trigger: trigger.id },
        'workflow: trigger scan failed for one row',
      );
    }
  }
}

async function fireDueTrigger(trigger: TriggerRow, now: Date): Promise<void> {
  if (trigger.type === 'at') {
    await fireTrigger(trigger);
    updateTriggerRow(trigger.id, { enabled: false, next_run_at: null });
    return;
  }

  const config = trigger.config as {
    cron: string;
    timezone?: string;
    quiet?: { start: string; end: string };
    catchup?: 'skip' | 'once' | 'all';
  };
  const timezone = config.timezone ?? TIMEZONE;
  const slots: string[] = [];
  let cursor = trigger.next_run_at!;
  while (cursor <= now.toISOString() && slots.length < MAX_CATCHUP_SLOTS) {
    slots.push(cursor);
    cursor = nextCronRun(config.cron, new Date(cursor), timezone);
  }

  const catchup = config.catchup ?? 'skip';
  const toRun =
    catchup === 'all'
      ? slots
      : catchup === 'once'
        ? slots.slice(-1)
        : slots.slice(-1);
  const skipped = catchup === 'skip' && slots.length > 1;

  for (const slot of skipped ? [] : toRun) {
    if (inQuietWindow(config.quiet, new Date(slot), timezone)) {
      logger.info(
        { trigger: trigger.id, slot },
        'workflow: cron slot inside quiet window, skipped',
      );
      continue;
    }
    await fireTrigger(trigger, { fired_at: slot }, `${trigger.id}@${slot}`);
  }

  updateTriggerRow(trigger.id, { next_run_at: cursor });
}

// Event triggers replace register_handler: one scan over unprocessed events,
// dispatched to every enabled trigger whose type and filter match.
export async function dispatchEvents(): Promise<void> {
  const events = getUnprocessedEvents();
  if (!events.length) return;
  const triggers = listTriggerRowsByType('event');
  for (const event of events) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.payload) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    for (const trigger of triggers) {
      if (trigger.config.event !== event.type) continue;
      const filter = trigger.config.filter as
        | Record<string, unknown>
        | undefined;
      if (filter && Object.entries(filter).some(([k, v]) => payload[k] !== v))
        continue;
      try {
        await fireTrigger(trigger, payload, `${trigger.id}@evt${event.id}`);
      } catch (err) {
        logger.error(
          { err, trigger: trigger.id, event: event.type },
          'workflow: event trigger failed',
        );
      }
    }
    markEventProcessed(event.id);
  }
}

const alertedRuns = new Set<string>();

// on_missed: a cron slot fired but the run it started has not succeeded within
// expected_within. Replaces the separate watchdog handler.
export async function checkMissedRuns(): Promise<void> {
  const now = nowDate().getTime();
  for (const workflow of listWorkflowRows()) {
    const policy = workflow.definition.policies?.alerts?.on_missed;
    if (!policy) continue;
    const triggerId = `${workflow.slug}:${policy.trigger}`;
    const trigger = getTriggerRow(triggerId) ?? getTriggerRow(policy.trigger);
    if (!trigger?.enabled || !trigger.last_run_id) continue;
    if (alertedRuns.has(trigger.last_run_id)) continue;

    const run = getRun(trigger.last_run_id);
    if (!run || run.status === 'succeeded') continue;
    // A run parked on a human step has plainly happened; its wait carries its
    // own expiry. on_missed is for slots that never got through.
    if (run.status === 'waiting') continue;

    let windowMs: number;
    try {
      windowMs = parseDuration(policy.expected_within);
    } catch {
      continue;
    }
    if (now - new Date(run.started_at).getTime() < windowMs) continue;

    alertedRuns.add(run.id);
    await sendAlert(
      run,
      workflow.definition.policies.alerts?.on_failure ?? 'owner',
      `[${workflow.name}] the ${policy.trigger} run from ${run.started_at} is still ${run.status} after ${policy.expected_within}.`,
    );
  }
}

export function findWebhookTrigger(token: string): TriggerRow | undefined {
  const hash = hashToken(token);
  return listTriggerRowsByType('webhook').find(
    (t) => t.config.token_hash === hash,
  );
}

export async function runManually(
  slug: string,
  inputs: Record<string, unknown> = {},
  createdBy?: string,
): Promise<StartRunResult> {
  const workflow = getWorkflowRow(slug);
  if (!workflow) throw new TriggerError(`unknown workflow: ${slug}`);
  const manual = listTriggerRows(slug).find((t) => t.type === 'manual');
  if (manual)
    return fireTrigger({ ...manual, args: { ...manual.args, ...inputs } });
  return startRun({
    slug,
    definition: workflow.definition,
    inputs,
    triggerType: 'manual',
    triggerPayload: createdBy ? { by: createdBy } : undefined,
  });
}

export type { EventRecord };
