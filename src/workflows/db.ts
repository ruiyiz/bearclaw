import { randomUUID } from 'node:crypto';

import { getDb } from '../db.js';
import { decodeBlobs } from '../utils/json.js';
import type { WorkflowDefinition } from './schema.js';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type StepStatus =
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'interrupted';

export type WaitKind = 'human' | 'event' | 'delay' | 'tool';
export type WaitStatus = 'open' | 'resolved' | 'expired' | 'cancelled';

export interface WorkflowIndexRow {
  slug: string;
  name: string;
  owner: string;
  enabled: boolean;
  file_path: string | null;
  file_hash: string | null;
  definition: WorkflowDefinition;
  last_run_id: string | null;
  last_status: string | null;
  updated_at: string;
}

export interface RunRow {
  id: string;
  slug: string;
  trigger_id: string | null;
  definition: WorkflowDefinition;
  definition_hash: string;
  run_key: string | null;
  inputs: Record<string, unknown>;
  trigger_payload: unknown;
  status: RunStatus;
  context: Record<string, unknown>;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  parent_run_id: string | null;
  forked_at_node: string | null;
}

export interface StepRow {
  id: number;
  run_id: string;
  node_id: string;
  attempt: number;
  status: StepStatus;
  port: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  log_path: string | null;
  agent_session_id: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface WaitRow {
  id: string;
  run_id: string;
  node_id: string;
  attempt: number;
  kind: WaitKind;
  status: WaitStatus;
  prompt: string | null;
  options: string[] | null;
  targets: string[] | null;
  fields: unknown;
  event_type: string | null;
  filter: Record<string, unknown> | null;
  event_floor: number | null;
  resume_at: string | null;
  on_timeout: unknown;
  token_hash: string | null;
  response: unknown;
  responder: string | null;
  responded_via: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface RunEventRow {
  id: number;
  run_id: string;
  ts: string;
  node_id: string | null;
  kind: string;
  payload: unknown;
}

function j(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function p<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

// ─── workflows index ────────────────────────────────────────────────────────

export function upsertWorkflowIndex(row: {
  slug: string;
  name: string;
  owner: string;
  enabled?: boolean;
  file_path?: string | null;
  file_hash?: string | null;
  definition: WorkflowDefinition;
}): void {
  getDb()
    .prepare(
      `INSERT INTO workflows (slug, name, owner, enabled, file_path, file_hash, definition, updated_at)
       VALUES (@slug, @name, @owner, @enabled, @file_path, @file_hash, @definition, @updated_at)
       ON CONFLICT(slug) DO UPDATE SET
         name = excluded.name, owner = excluded.owner, file_path = excluded.file_path,
         file_hash = excluded.file_hash, definition = excluded.definition,
         updated_at = excluded.updated_at`,
    )
    .run({
      slug: row.slug,
      name: row.name,
      owner: row.owner,
      enabled: row.enabled === false ? 0 : 1,
      file_path: row.file_path ?? null,
      file_hash: row.file_hash ?? null,
      definition: JSON.stringify(row.definition),
      updated_at: new Date().toISOString(),
    });
}

function toIndexRow(raw: Record<string, unknown>): WorkflowIndexRow {
  const r = decodeBlobs(raw);
  return {
    slug: String(r.slug),
    name: String(r.name),
    owner: String(r.owner),
    enabled: Number(r.enabled) === 1,
    file_path: (r.file_path as string) ?? null,
    file_hash: (r.file_hash as string) ?? null,
    definition: p(r.definition, {} as WorkflowDefinition),
    last_run_id: (r.last_run_id as string) ?? null,
    last_status: (r.last_status as string) ?? null,
    updated_at: String(r.updated_at),
  };
}

export function getWorkflowRow(slug: string): WorkflowIndexRow | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM workflows WHERE slug = ?`)
    .get(slug) as Record<string, unknown> | undefined;
  return row ? toIndexRow(row) : undefined;
}

export function listWorkflowRows(): WorkflowIndexRow[] {
  return (
    getDb().prepare(`SELECT * FROM workflows ORDER BY slug`).all() as Record<
      string,
      unknown
    >[]
  ).map(toIndexRow);
}

export function deleteWorkflowRow(slug: string): void {
  getDb().prepare(`DELETE FROM workflows WHERE slug = ?`).run(slug);
}

export function setWorkflowEnabled(slug: string, enabled: boolean): void {
  getDb()
    .prepare(`UPDATE workflows SET enabled = ? WHERE slug = ?`)
    .run(enabled ? 1 : 0, slug);
}

// ─── runs ───────────────────────────────────────────────────────────────────

export function insertRun(row: {
  id: string;
  slug: string;
  trigger_id?: string | null;
  definition: WorkflowDefinition;
  definition_hash: string;
  run_key?: string | null;
  inputs: Record<string, unknown>;
  trigger_payload?: unknown;
  status: RunStatus;
  parent_run_id?: string | null;
  forked_at_node?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO workflow_runs
         (id, slug, trigger_id, definition, definition_hash, run_key, inputs,
          trigger_payload, status, context, started_at, parent_run_id, forked_at_node)
       VALUES (@id, @slug, @trigger_id, @definition, @definition_hash, @run_key, @inputs,
               @trigger_payload, @status, '{}', @started_at, @parent_run_id, @forked_at_node)`,
    )
    .run({
      id: row.id,
      slug: row.slug,
      trigger_id: row.trigger_id ?? null,
      definition: JSON.stringify(row.definition),
      definition_hash: row.definition_hash,
      run_key: row.run_key ?? null,
      inputs: JSON.stringify(row.inputs),
      trigger_payload: j(row.trigger_payload),
      status: row.status,
      started_at: new Date().toISOString(),
      parent_run_id: row.parent_run_id ?? null,
      forked_at_node: row.forked_at_node ?? null,
    });
}

function toRunRow(raw: Record<string, unknown>): RunRow {
  const r = decodeBlobs(raw);
  return {
    id: String(r.id),
    slug: String(r.slug),
    trigger_id: (r.trigger_id as string) ?? null,
    definition: p(r.definition, {} as WorkflowDefinition),
    definition_hash: String(r.definition_hash),
    run_key: (r.run_key as string) ?? null,
    inputs: p(r.inputs, {} as Record<string, unknown>),
    trigger_payload: p(r.trigger_payload, null),
    status: r.status as RunStatus,
    context: p(r.context, {} as Record<string, unknown>),
    started_at: String(r.started_at),
    finished_at: (r.finished_at as string) ?? null,
    error: (r.error as string) ?? null,
    parent_run_id: (r.parent_run_id as string) ?? null,
    forked_at_node: (r.forked_at_node as string) ?? null,
  };
}

export function getRun(id: string): RunRow | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM workflow_runs WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? toRunRow(row) : undefined;
}

export function listRuns(slug?: string, limit = 50): RunRow[] {
  const rows = slug
    ? getDb()
        .prepare(
          `SELECT * FROM workflow_runs WHERE slug = ? ORDER BY started_at DESC LIMIT ?`,
        )
        .all(slug, limit)
    : getDb()
        .prepare(`SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT ?`)
        .all(limit);
  return (rows as Record<string, unknown>[]).map(toRunRow);
}

export function listRunsByStatus(statuses: RunStatus[]): RunRow[] {
  if (!statuses.length) return [];
  const marks = statuses.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(
      `SELECT * FROM workflow_runs WHERE status IN (${marks}) ORDER BY started_at`,
    )
    .all(...statuses);
  return (rows as Record<string, unknown>[]).map(toRunRow);
}

export function activeRuns(slug: string): RunRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM workflow_runs WHERE slug = ? AND status IN ('queued','running','waiting') ORDER BY started_at`,
    )
    .all(slug);
  return (rows as Record<string, unknown>[]).map(toRunRow);
}

export function updateRun(
  id: string,
  patch: Partial<{
    status: RunStatus;
    context: Record<string, unknown>;
    finished_at: string | null;
    error: string | null;
  }>,
): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.status !== undefined) {
    sets.push('status = @status');
    params.status = patch.status;
  }
  if (patch.context !== undefined) {
    sets.push('context = @context');
    params.context = JSON.stringify(patch.context);
  }
  if (patch.finished_at !== undefined) {
    sets.push('finished_at = @finished_at');
    params.finished_at = patch.finished_at;
  }
  if (patch.error !== undefined) {
    sets.push('error = @error');
    params.error = patch.error;
  }
  if (!sets.length) return;
  getDb()
    .prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = @id`)
    .run(params);
  if (patch.status) {
    getDb()
      .prepare(
        `UPDATE workflows SET last_run_id = ?, last_status = ? WHERE slug = (SELECT slug FROM workflow_runs WHERE id = ?)`,
      )
      .run(id, patch.status, id);
  }
}

// ─── steps ──────────────────────────────────────────────────────────────────

export function insertStep(row: {
  run_id: string;
  node_id: string;
  attempt: number;
  status: StepStatus;
  input?: unknown;
}): number {
  const res = getDb()
    .prepare(
      `INSERT INTO workflow_steps (run_id, node_id, attempt, status, input, started_at)
       VALUES (@run_id, @node_id, @attempt, @status, @input, @started_at)`,
    )
    .run({
      run_id: row.run_id,
      node_id: row.node_id,
      attempt: row.attempt,
      status: row.status,
      input: j(row.input),
      started_at: new Date().toISOString(),
    });
  return Number(res.lastInsertRowid);
}

export function updateStep(
  id: number,
  patch: Partial<{
    status: StepStatus;
    port: string | null;
    output: unknown;
    error: string | null;
    log_path: string | null;
    agent_session_id: string | null;
    finished_at: string | null;
  }>,
): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const key of [
    'status',
    'port',
    'error',
    'log_path',
    'agent_session_id',
    'finished_at',
  ] as const) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      params[key] = patch[key];
    }
  }
  if (patch.output !== undefined) {
    sets.push('output = @output');
    params.output = j(patch.output);
  }
  if (!sets.length) return;
  getDb()
    .prepare(`UPDATE workflow_steps SET ${sets.join(', ')} WHERE id = @id`)
    .run(params);
}

function toStepRow(raw: Record<string, unknown>): StepRow {
  const r = decodeBlobs(raw);
  return {
    id: Number(r.id),
    run_id: String(r.run_id),
    node_id: String(r.node_id),
    attempt: Number(r.attempt),
    status: r.status as StepStatus,
    port: (r.port as string) ?? null,
    input: p(r.input, null),
    output: p(r.output, null),
    error: (r.error as string) ?? null,
    log_path: (r.log_path as string) ?? null,
    agent_session_id: (r.agent_session_id as string) ?? null,
    started_at: String(r.started_at),
    finished_at: (r.finished_at as string) ?? null,
  };
}

export function listSteps(runId: string): StepRow[] {
  return (
    getDb()
      .prepare(`SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY id`)
      .all(runId) as Record<string, unknown>[]
  ).map(toStepRow);
}

export function getStepById(id: number): StepRow | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM workflow_steps WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? toStepRow(row) : undefined;
}

// ─── waits ──────────────────────────────────────────────────────────────────

export function insertWait(row: {
  id: string;
  run_id: string;
  node_id: string;
  attempt: number;
  kind: WaitKind;
  prompt?: string | null;
  options?: string[] | null;
  targets?: string[] | null;
  fields?: unknown;
  event_type?: string | null;
  filter?: Record<string, unknown> | null;
  event_floor?: number | null;
  resume_at?: string | null;
  on_timeout?: unknown;
  token_hash?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO workflow_waits
         (id, run_id, node_id, attempt, kind, status, prompt, options, targets, fields,
          event_type, filter, event_floor, resume_at, on_timeout, token_hash, created_at)
       VALUES (@id, @run_id, @node_id, @attempt, @kind, 'open', @prompt, @options, @targets, @fields,
               @event_type, @filter, @event_floor, @resume_at, @on_timeout, @token_hash, @created_at)`,
    )
    .run({
      id: row.id,
      run_id: row.run_id,
      node_id: row.node_id,
      attempt: row.attempt,
      kind: row.kind,
      prompt: row.prompt ?? null,
      options: j(row.options ?? undefined),
      targets: j(row.targets ?? undefined),
      fields: j(row.fields),
      event_type: row.event_type ?? null,
      filter: j(row.filter ?? undefined),
      event_floor: row.event_floor ?? null,
      resume_at: row.resume_at ?? null,
      on_timeout: j(row.on_timeout),
      token_hash: row.token_hash ?? null,
      created_at: new Date().toISOString(),
    });
}

function toWaitRow(raw: Record<string, unknown>): WaitRow {
  const r = decodeBlobs(raw);
  return {
    id: String(r.id),
    run_id: String(r.run_id),
    node_id: String(r.node_id),
    attempt: Number(r.attempt),
    kind: r.kind as WaitKind,
    status: r.status as WaitStatus,
    prompt: (r.prompt as string) ?? null,
    options: p(r.options, null),
    targets: p(r.targets, null),
    fields: p(r.fields, null),
    event_type: (r.event_type as string) ?? null,
    filter: p(r.filter, null),
    event_floor: r.event_floor === null ? null : Number(r.event_floor),
    resume_at: (r.resume_at as string) ?? null,
    on_timeout: p(r.on_timeout, null),
    token_hash: (r.token_hash as string) ?? null,
    response: p(r.response, null),
    responder: (r.responder as string) ?? null,
    responded_via: (r.responded_via as string) ?? null,
    created_at: String(r.created_at),
    resolved_at: (r.resolved_at as string) ?? null,
  };
}

export function getWait(id: string): WaitRow | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM workflow_waits WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? toWaitRow(row) : undefined;
}

export function listOpenWaits(kind?: WaitKind): WaitRow[] {
  const rows = kind
    ? getDb()
        .prepare(
          `SELECT * FROM workflow_waits WHERE status = 'open' AND kind = ? ORDER BY created_at`,
        )
        .all(kind)
    : getDb()
        .prepare(
          `SELECT * FROM workflow_waits WHERE status = 'open' ORDER BY created_at`,
        )
        .all();
  return (rows as Record<string, unknown>[]).map(toWaitRow);
}

export function listWaitsForRun(runId: string): WaitRow[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM workflow_waits WHERE run_id = ? ORDER BY created_at`,
      )
      .all(runId) as Record<string, unknown>[]
  ).map(toWaitRow);
}

export function listDueWaits(nowIso: string): WaitRow[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM workflow_waits
         WHERE status = 'open' AND resume_at IS NOT NULL AND resume_at <= ?
         ORDER BY resume_at`,
      )
      .all(nowIso) as Record<string, unknown>[]
  ).map(toWaitRow);
}

export function closeWait(
  id: string,
  patch: {
    status: WaitStatus;
    response?: unknown;
    responder?: string | null;
    responded_via?: string | null;
  },
): void {
  getDb()
    .prepare(
      `UPDATE workflow_waits
       SET status = @status, response = @response, responder = @responder,
           responded_via = @responded_via, resolved_at = @resolved_at
       WHERE id = @id AND status = 'open'`,
    )
    .run({
      id,
      status: patch.status,
      response: j(patch.response),
      responder: patch.responder ?? null,
      responded_via: patch.responded_via ?? null,
      resolved_at: new Date().toISOString(),
    });
}

export function cancelWaitsForRun(runId: string): void {
  getDb()
    .prepare(
      `UPDATE workflow_waits SET status = 'cancelled', resolved_at = ?
       WHERE run_id = ? AND status = 'open'`,
    )
    .run(new Date().toISOString(), runId);
}

// ─── run timeline ───────────────────────────────────────────────────────────

export function appendRunEvent(
  runId: string,
  kind: string,
  nodeId: string | null,
  payload?: unknown,
): void {
  getDb()
    .prepare(
      `INSERT INTO workflow_events (run_id, ts, node_id, kind, payload)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(runId, new Date().toISOString(), nodeId, kind, j(payload));
}

export function listRunEvents(runId: string): RunEventRow[] {
  return (
    getDb()
      .prepare(`SELECT * FROM workflow_events WHERE run_id = ? ORDER BY id`)
      .all(runId) as Record<string, unknown>[]
  ).map((raw) => {
    const r = decodeBlobs(raw);
    return {
      id: Number(r.id),
      run_id: String(r.run_id),
      ts: String(r.ts),
      node_id: (r.node_id as string) ?? null,
      kind: String(r.kind),
      payload: p(r.payload, null),
    };
  });
}

// ─── triggers ───────────────────────────────────────────────────────────────

export type TriggerType = 'cron' | 'event' | 'manual' | 'webhook' | 'at';
export type TriggerSource = 'file' | 'runtime';

export interface TriggerRow {
  id: string;
  slug: string;
  type: TriggerType;
  source: TriggerSource;
  config: Record<string, unknown>;
  args: Record<string, unknown>;
  enabled: boolean;
  next_run_at: string | null;
  last_run_id: string | null;
  last_fired_at: string | null;
  created_by: string | null;
  created_at: string;
}

function toTriggerRow(raw: Record<string, unknown>): TriggerRow {
  const r = decodeBlobs(raw);
  return {
    id: String(r.id),
    slug: String(r.slug),
    type: r.type as TriggerType,
    source: r.source as TriggerSource,
    config: p(r.config, {} as Record<string, unknown>),
    args: p(r.args, {} as Record<string, unknown>),
    enabled: Number(r.enabled) === 1,
    next_run_at: (r.next_run_at as string) ?? null,
    last_run_id: (r.last_run_id as string) ?? null,
    last_fired_at: (r.last_fired_at as string) ?? null,
    created_by: (r.created_by as string) ?? null,
    created_at: String(r.created_at),
  };
}

export function upsertTrigger(row: {
  id: string;
  slug: string;
  type: TriggerType;
  source: TriggerSource;
  config: Record<string, unknown>;
  args: Record<string, unknown>;
  enabled: boolean;
  next_run_at?: string | null;
  created_by?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO workflow_triggers
         (id, slug, type, source, config, args, enabled, next_run_at, created_by, created_at)
       VALUES (@id, @slug, @type, @source, @config, @args, @enabled, @next_run_at, @created_by, @created_at)
       ON CONFLICT(id) DO UPDATE SET
         slug = excluded.slug, type = excluded.type, source = excluded.source,
         config = excluded.config, args = excluded.args,
         next_run_at = excluded.next_run_at`,
    )
    .run({
      id: row.id,
      slug: row.slug,
      type: row.type,
      source: row.source,
      config: JSON.stringify(row.config),
      args: JSON.stringify(row.args),
      enabled: row.enabled ? 1 : 0,
      next_run_at: row.next_run_at ?? null,
      created_by: row.created_by ?? null,
      created_at: new Date().toISOString(),
    });
}

export function getTriggerRow(id: string): TriggerRow | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM workflow_triggers WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? toTriggerRow(row) : undefined;
}

export function listTriggerRows(slug?: string): TriggerRow[] {
  const rows = slug
    ? getDb()
        .prepare(
          `SELECT * FROM workflow_triggers WHERE slug = ? ORDER BY created_at`,
        )
        .all(slug)
    : getDb()
        .prepare(`SELECT * FROM workflow_triggers ORDER BY next_run_at`)
        .all();
  return (rows as Record<string, unknown>[]).map(toTriggerRow);
}

export function listTriggerRowsByType(type: TriggerType): TriggerRow[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM workflow_triggers WHERE type = ? AND enabled = 1 ORDER BY created_at`,
      )
      .all(type) as Record<string, unknown>[]
  ).map(toTriggerRow);
}

export function listDueTriggerRows(nowIso: string): TriggerRow[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM workflow_triggers
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
           AND type IN ('cron','at')
         ORDER BY next_run_at`,
      )
      .all(nowIso) as Record<string, unknown>[]
  ).map(toTriggerRow);
}

export function updateTriggerRow(
  id: string,
  patch: Partial<{
    enabled: boolean;
    config: Record<string, unknown>;
    args: Record<string, unknown>;
    next_run_at: string | null;
    last_run_id: string | null;
    last_fired_at: string | null;
  }>,
): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.enabled !== undefined) {
    sets.push('enabled = @enabled');
    params.enabled = patch.enabled ? 1 : 0;
  }
  if (patch.config !== undefined) {
    sets.push('config = @config');
    params.config = JSON.stringify(patch.config);
  }
  if (patch.args !== undefined) {
    sets.push('args = @args');
    params.args = JSON.stringify(patch.args);
  }
  for (const key of ['next_run_at', 'last_run_id', 'last_fired_at'] as const) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      params[key] = patch[key];
    }
  }
  if (!sets.length) return;
  getDb()
    .prepare(`UPDATE workflow_triggers SET ${sets.join(', ')} WHERE id = @id`)
    .run(params);
}

export function deleteTriggerRow(id: string): void {
  getDb().prepare(`DELETE FROM workflow_triggers WHERE id = ?`).run(id);
}

export function deleteFileTriggersExcept(
  slug: string,
  keep: string[],
): string[] {
  const rows = listTriggerRows(slug).filter(
    (t) => t.source === 'file' && !keep.includes(t.id),
  );
  for (const row of rows) deleteTriggerRow(row.id);
  return rows.map((r) => r.id);
}
