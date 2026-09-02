import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { VAR_DIR } from '../config.js';
import { logger } from '../logger.js';
import { webBroker } from '../server/broker.js';
import {
  activeRuns,
  appendRunEvent,
  cancelWaitsForRun,
  closeWait,
  getRun,
  getWait,
  getWorkflowRow,
  insertRun,
  insertStep,
  insertWait,
  listDueWaits,
  listOpenWaits,
  listRunsByStatus,
  listSteps,
  newId,
  updateRun,
  updateStep,
  type RunRow,
  type StepRow,
  type WaitRow,
} from './db.js';
import { executors } from './executors/index.js';
import { parseDuration, type EvalScope } from './expr.js';
import { defaultDeps } from './deps.js';
import type { EngineDeps, ExecResult, WaitSpec } from './runtime.js';
import { stepKeyFor } from './runtime.js';
import {
  DEFAULT_PORT,
  ERROR_PORT,
  entryNodes,
  portsOf,
  topoOrder,
  type WorkflowDefinition,
  type WorkflowNode,
} from './schema.js';

const SPILL_THRESHOLD_BYTES = 32_768;

function publishRun(runId: string, slug: string, status: string): void {
  webBroker.publishWorkflow({
    type: 'run.status',
    runId,
    slug,
    status,
    ts: Date.now(),
  });
}

function publishStep(
  run: RunRow,
  nodeId: string,
  status: string,
  port?: string | null,
): void {
  webBroker.publishWorkflow({
    type: 'step.status',
    runId: run.id,
    slug: run.slug,
    nodeId,
    status,
    port,
    ts: Date.now(),
  });
}

let deps: EngineDeps = defaultDeps;

export function setEngineDeps(next: EngineDeps): void {
  deps = next;
}

export function getEngineDeps(): EngineDeps {
  return deps;
}

const aborters = new Map<string, AbortController>();
const advancing = new Map<string, Promise<void>>();

export function definitionHash(def: WorkflowDefinition): string {
  return createHash('sha256')
    .update(JSON.stringify(def))
    .digest('hex')
    .slice(0, 16);
}

// ─── inputs ─────────────────────────────────────────────────────────────────

export class InputValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid workflow inputs: ${issues.join('; ')}`);
    this.name = 'InputValidationError';
  }
}

export function applyInputs(
  def: WorkflowDefinition,
  raw: Record<string, unknown> = {},
): Record<string, unknown> {
  const schema = def.inputs;
  if (!schema) return { ...raw };
  const out: Record<string, unknown> = { ...raw };
  const issues: string[] = [];
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    const s = spec as { default?: unknown; type?: string };
    if (out[key] === undefined && s.default !== undefined) out[key] = s.default;
    const value = out[key];
    if (value === undefined || !s.type) continue;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    const ok =
      s.type === 'integer'
        ? Number.isInteger(value)
        : s.type === 'number'
          ? typeof value === 'number'
          : s.type === actual;
    if (!ok) issues.push(`${key} should be ${s.type}`);
  }
  for (const key of schema.required ?? [])
    if (out[key] === undefined) issues.push(`${key} is required`);
  if (issues.length) throw new InputValidationError(issues);
  return out;
}

// ─── scope ──────────────────────────────────────────────────────────────────

function spillPath(runId: string, nodeId: string, attempt: number): string {
  return path.join(VAR_DIR, 'workflows', runId, `${nodeId}-${attempt}.json`);
}

function storeOutput(
  runId: string,
  nodeId: string,
  attempt: number,
  output: unknown,
): unknown {
  const encoded = JSON.stringify(output ?? null);
  if (encoded.length <= SPILL_THRESHOLD_BYTES) return output;
  const file = spillPath(runId, nodeId, attempt);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encoded);
  return { $file: file, bytes: encoded.length };
}

function loadOutput(stored: unknown): unknown {
  if (
    stored &&
    typeof stored === 'object' &&
    typeof (stored as { $file?: unknown }).$file === 'string'
  ) {
    try {
      return JSON.parse(
        fs.readFileSync((stored as { $file: string }).$file, 'utf-8'),
      );
    } catch (err) {
      logger.warn({ err }, 'workflow: spilled output unreadable');
      return null;
    }
  }
  return stored;
}

function latestSteps(steps: StepRow[]): Map<string, StepRow> {
  const latest = new Map<string, StepRow>();
  for (const s of steps) {
    const prev = latest.get(s.node_id);
    if (!prev || s.attempt >= prev.attempt) latest.set(s.node_id, s);
  }
  return latest;
}

function buildScope(
  run: RunRow,
  steps: StepRow[],
  extra: Partial<EvalScope> = {},
): EvalScope {
  const nodes: EvalScope['nodes'] = {};
  let lastError: { node: string; message: string } | null = null;
  for (const [id, step] of latestSteps(steps)) {
    nodes[id] = { output: loadOutput(step.output), status: step.status };
    if (step.status === 'failed')
      lastError = { node: id, message: step.error ?? 'step failed' };
  }
  return {
    run: {
      id: run.id,
      slug: run.slug,
      started_at: run.started_at,
      key: run.run_key ?? run.id,
    },
    trigger: {
      id: run.trigger_id,
      type:
        (run.context.__trigger_type as string | undefined) ??
        (run.trigger_id ? null : 'manual'),
      payload: run.trigger_payload,
    },
    inputs: run.inputs,
    nodes,
    env: deps.env,
    error: lastError,
    ...extra,
  };
}

// ─── graph state ────────────────────────────────────────────────────────────

type NodeState =
  | { k: 'unreached' }
  | { k: 'ready' }
  | { k: 'running' }
  | { k: 'waiting' }
  | { k: 'done'; port: string }
  | { k: 'failed' }
  | { k: 'dead' };

export function computeStates(
  def: WorkflowDefinition,
  steps: StepRow[],
): Map<string, NodeState> {
  const latest = latestSteps(steps);
  const states = new Map<string, NodeState>();
  const entries = new Set(entryNodes(def));
  for (const id of topoOrder(def)) {
    const step = latest.get(id);
    if (step) {
      switch (step.status) {
        case 'running':
          states.set(id, { k: 'running' });
          break;
        case 'waiting':
          states.set(id, { k: 'waiting' });
          break;
        case 'succeeded':
          states.set(id, { k: 'done', port: step.port ?? DEFAULT_PORT });
          break;
        case 'failed':
          states.set(
            id,
            step.port === ERROR_PORT
              ? { k: 'done', port: ERROR_PORT }
              : { k: 'failed' },
          );
          break;
        case 'skipped':
          states.set(id, { k: 'dead' });
          break;
        case 'interrupted':
          states.set(id, { k: 'ready' });
          break;
      }
      continue;
    }
    if (entries.has(id)) {
      states.set(id, { k: 'ready' });
      continue;
    }
    let pending = false;
    let satisfied = false;
    for (const edge of def.edges) {
      if (edge.to !== id) continue;
      const src = states.get(edge.from) ?? { k: 'unreached' };
      if (src.k === 'done') {
        if (src.port === edge.port) satisfied = true;
      } else if (src.k === 'dead' || src.k === 'failed') {
        // dead branch: never blocks the join
      } else {
        pending = true;
      }
    }
    states.set(
      id,
      pending ? { k: 'unreached' } : satisfied ? { k: 'ready' } : { k: 'dead' },
    );
  }
  return states;
}

// ─── run lifecycle ──────────────────────────────────────────────────────────

export interface StartRunOptions {
  slug: string;
  definition?: WorkflowDefinition;
  inputs?: Record<string, unknown>;
  triggerId?: string | null;
  triggerType?: string | null;
  triggerPayload?: unknown;
  runKey?: string | null;
  parentRunId?: string | null;
}

export interface StartRunResult {
  runId: string | null;
  status: 'started' | 'queued' | 'skipped' | 'duplicate';
}

export async function startRun(opts: StartRunOptions): Promise<StartRunResult> {
  const def = opts.definition ?? getWorkflowRow(opts.slug)?.definition;
  if (!def) throw new Error(`unknown workflow: ${opts.slug}`);

  const inputs = applyInputs(def, opts.inputs ?? {});
  const concurrency = def.policies.concurrency;
  const active = activeRuns(def.slug);

  if (active.length && concurrency === 'skip') {
    logger.info(
      { slug: def.slug },
      'workflow: run skipped, one already active',
    );
    return { runId: null, status: 'skipped' };
  }
  if (active.length && concurrency === 'replace') {
    for (const run of active) await cancelRun(run.id, 'replaced by a new run');
  }

  const id = newId('run');
  try {
    insertRun({
      id,
      slug: def.slug,
      trigger_id: opts.triggerId ?? null,
      definition: def,
      definition_hash: definitionHash(def),
      run_key: opts.runKey ?? null,
      inputs,
      trigger_payload: opts.triggerPayload,
      status: active.length && concurrency === 'queue' ? 'queued' : 'running',
      parent_run_id: opts.parentRunId ?? null,
    });
  } catch (err) {
    if (String(err).includes('UNIQUE') && opts.runKey)
      return { runId: null, status: 'duplicate' };
    throw err;
  }

  updateRun(id, {
    context: {
      __event_floor: deps.latestEventId(),
      __trigger_type: opts.triggerType ?? 'manual',
    },
  });
  appendRunEvent(id, 'run.started', null, { inputs });
  publishRun(id, def.slug, 'running');

  if (active.length && concurrency === 'queue')
    return { runId: id, status: 'queued' };

  await advance(id);
  return { runId: id, status: 'started' };
}

export async function cancelRun(
  runId: string,
  reason = 'cancelled',
): Promise<void> {
  aborters.get(runId)?.abort();
  cancelWaitsForRun(runId);
  updateRun(runId, {
    status: 'cancelled',
    error: reason,
    finished_at: new Date().toISOString(),
  });
  appendRunEvent(runId, 'run.cancelled', null, { reason });
  publishRun(runId, getRun(runId)?.slug ?? '', 'cancelled');
  await startNextQueued(getRun(runId)?.slug);
}

async function startNextQueued(slug?: string): Promise<void> {
  if (!slug) return;
  const queued = activeRuns(slug).filter((r) => r.status === 'queued');
  const busy = activeRuns(slug).some(
    (r) => r.status === 'running' || r.status === 'waiting',
  );
  if (busy || !queued.length) return;
  updateRun(queued[0].id, { status: 'running' });
  await advance(queued[0].id);
}

// ─── decider ────────────────────────────────────────────────────────────────

export async function advance(runId: string): Promise<void> {
  const inflight = advancing.get(runId);
  if (inflight) {
    await inflight;
    return;
  }
  const task = advanceInner(runId).finally(() => advancing.delete(runId));
  advancing.set(runId, task);
  await task;
}

async function advanceInner(runId: string): Promise<void> {
  for (;;) {
    const run = getRun(runId);
    if (!run) return;
    if (run.status !== 'running' && run.status !== 'waiting') return;

    const steps = listSteps(runId);
    const states = computeStates(run.definition, steps);

    const ready = [...states.entries()]
      .filter(([, s]) => s.k === 'ready')
      .map(([id]) => id);

    if (!ready.length) {
      const busy = [...states.values()].some(
        (s) => s.k === 'running' || s.k === 'waiting' || s.k === 'unreached',
      );
      const failed = [...states.entries()].find(([, s]) => s.k === 'failed');
      if (failed) {
        await finalize(run, 'failed', failedMessage(steps, failed[0]));
        return;
      }
      if ([...states.values()].some((s) => s.k === 'waiting')) {
        if (run.status !== 'waiting') {
          updateRun(runId, { status: 'waiting' });
          publishRun(runId, run.slug, 'waiting');
        }
        return;
      }
      if (busy) return;
      await finalize(run, 'succeeded', null);
      return;
    }

    if (run.status !== 'running') updateRun(runId, { status: 'running' });
    await Promise.all(ready.map((id) => executeNode(run, id, steps)));
  }
}

function failedMessage(steps: StepRow[], nodeId: string): string {
  const step = latestSteps(steps).get(nodeId);
  return `node "${nodeId}" failed: ${step?.error ?? 'unknown error'}`;
}

// The watchdog handler pattern becomes a one-line policy: on_failure names a
// folder (or 'owner') and the run's error goes there.
export async function sendAlert(
  run: RunRow,
  target: string,
  text: string,
): Promise<void> {
  const folder = target === 'owner' ? run.definition.owner : target;
  try {
    await deps.send({
      folder: folder.includes(':') ? run.definition.owner : folder,
      to: folder.includes(':') ? folder : undefined,
      text,
      stepKey: `${run.id}:alert`,
    });
  } catch (err) {
    logger.warn({ err, run: run.id }, 'workflow: alert delivery failed');
  }
}

async function finalize(
  run: RunRow,
  status: 'succeeded' | 'failed',
  error: string | null,
): Promise<void> {
  if (status === 'failed') {
    const handler = run.definition.policies.on_error;
    const steps = listSteps(run.id);
    const alreadyRan = steps.some((s) => s.node_id === handler);
    if (handler && run.definition.nodes[handler] && !alreadyRan) {
      await executeNode(run, handler, steps);
    }
    cancelWaitsForRun(run.id);
  }
  updateRun(run.id, {
    status,
    error,
    finished_at: new Date().toISOString(),
  });
  appendRunEvent(run.id, `run.${status}`, null, error ? { error } : undefined);
  publishRun(run.id, run.slug, status);
  // A parent run waits on this event; anything else on the bus can too.
  const leaves = Object.keys(run.definition.nodes).filter(
    (id) => !run.definition.edges.some((e) => e.from === id),
  );
  const finished = latestSteps(listSteps(run.id));
  const outputs: Record<string, unknown> = {};
  for (const id of leaves) {
    const step = finished.get(id);
    if (step?.status === 'succeeded') outputs[id] = loadOutput(step.output);
  }
  deps.emitEvent('workflow.run.finished', {
    run_id: run.id,
    slug: run.slug,
    status,
    error,
    outputs,
  });

  const onFailure = run.definition.policies.alerts?.on_failure;
  if (status === 'failed' && onFailure)
    await sendAlert(
      run,
      onFailure,
      `[${run.definition.name}] run failed: ${error ?? 'unknown error'}`,
    );
  logger.info({ run: run.id, slug: run.slug, status }, 'workflow run finished');
  await startNextQueued(run.slug);
}

function nextAttempt(steps: StepRow[], nodeId: string): number {
  const attempts = steps
    .filter((s) => s.node_id === nodeId)
    .map((s) => s.attempt);
  return attempts.length ? Math.max(...attempts) + 1 : 1;
}

function aborterFor(runId: string): AbortController {
  let ac = aborters.get(runId);
  if (!ac || ac.signal.aborted) {
    ac = new AbortController();
    aborters.set(runId, ac);
  }
  return ac;
}

async function executeNode(
  run: RunRow,
  nodeId: string,
  priorSteps: StepRow[],
): Promise<void> {
  const node = run.definition.nodes[nodeId];
  if (!node) return;
  const retryMax = node.retry?.max ?? 0;
  const backoffMs = node.retry?.backoff ? parseDuration(node.retry.backoff) : 0;

  let attempt = nextAttempt(priorSteps, nodeId);
  for (;;) {
    const stepKey = stepKeyFor(run.id, nodeId, attempt);
    const steps = listSteps(run.id);
    const scope = buildScope(run, steps);
    const stepId = insertStep({
      run_id: run.id,
      node_id: nodeId,
      attempt,
      status: 'running',
      input: { step_key: stepKey },
    });
    appendRunEvent(run.id, 'step.started', nodeId, { attempt });
    publishStep(run, nodeId, 'running');

    let result: ExecResult;
    try {
      result = await executors[node.type]({
        run,
        def: run.definition,
        nodeId,
        node,
        attempt,
        stepKey,
        scope,
        signal: aborterFor(run.id).signal,
        deps,
      });
    } catch (err) {
      result = {
        kind: 'fail',
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      };
    }

    if (result.kind === 'done') {
      if (result.sessionId) rememberSession(run, node, result.sessionId);
      updateStep(stepId, {
        status: 'succeeded',
        port: result.port ?? DEFAULT_PORT,
        output: storeOutput(run.id, nodeId, attempt, result.output),
        agent_session_id: result.sessionId ?? null,
        finished_at: new Date().toISOString(),
      });
      appendRunEvent(run.id, 'step.succeeded', nodeId, {
        port: result.port ?? DEFAULT_PORT,
      });
      publishStep(run, nodeId, 'succeeded', result.port ?? DEFAULT_PORT);
      return;
    }

    if (result.kind === 'wait') {
      const waitId = openWait(run, nodeId, attempt, result.wait);
      updateStep(stepId, { status: 'waiting' });
      await notifyWait(run, nodeId, waitId, result.wait);
      appendRunEvent(run.id, 'wait.opened', nodeId, {
        wait_id: waitId,
        kind: result.wait.kind,
      });
      publishStep(run, nodeId, 'waiting');
      webBroker.publishWorkflow({
        type: 'wait.opened',
        runId: run.id,
        slug: run.slug,
        nodeId,
        waitId,
        ts: Date.now(),
      });
      return;
    }

    const canRetry = result.retryable !== false && attempt <= retryMax;
    if (canRetry) {
      updateStep(stepId, {
        status: 'failed',
        error: result.message,
        finished_at: new Date().toISOString(),
      });
      appendRunEvent(run.id, 'step.retrying', nodeId, {
        attempt,
        error: result.message,
      });
      if (backoffMs > 0) await sleep(backoffMs);
      attempt += 1;
      continue;
    }

    const hasErrorEdge = run.definition.edges.some(
      (e) => e.from === nodeId && e.port === ERROR_PORT,
    );
    updateStep(stepId, {
      status: 'failed',
      port: hasErrorEdge ? ERROR_PORT : null,
      error: result.message,
      finished_at: new Date().toISOString(),
    });
    appendRunEvent(run.id, 'step.failed', nodeId, {
      attempt,
      error: result.message,
      routed: hasErrorEdge,
    });
    publishStep(run, nodeId, 'failed', hasErrorEdge ? ERROR_PORT : null);
    return;
  }
}

function rememberSession(
  run: RunRow,
  node: WorkflowNode,
  sessionId: string,
): void {
  if (node.type !== 'agent' || node.session !== 'run') return;
  const folder = node.agent ?? run.definition.owner;
  const fresh = getRun(run.id);
  if (!fresh) return;
  const context = {
    ...fresh.context,
    __sessions: {
      ...((fresh.context.__sessions as Record<string, string>) ?? {}),
      [`agent:${folder}`]: sessionId,
    },
  };
  updateRun(run.id, { context });
  run.context = context;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── waits ──────────────────────────────────────────────────────────────────

// A human step is only useful if someone hears about it. Targets default to
// the owning agent's primary channel; the web inbox always has it too.
async function notifyWait(
  run: RunRow,
  nodeId: string,
  waitId: string,
  spec: WaitSpec,
): Promise<void> {
  if (spec.kind !== 'human') return;
  const node = run.definition.nodes[nodeId];
  if (node && node.type === 'human' && node.notify === false) return;
  const folder =
    (node && 'agent' in node ? node.agent : undefined) ?? run.definition.owner;
  const hint =
    spec.options && spec.options.length
      ? `Reply with one of: ${spec.options.join(', ')}`
      : node && node.type === 'human' && node.kind === 'approve'
        ? 'Reply approve or reject.'
        : 'Reply here, or answer in the inbox.';
  const ttlMs = spec.resume_at
    ? Math.max(
        new Date(spec.resume_at).getTime() - deps.now().getTime(),
        60_000,
      )
    : 3 * 86_400_000;
  const actions =
    node && node.type === 'human'
      ? node.kind === 'approve'
        ? ['approved', 'rejected']
        : node.kind === 'choice'
          ? (node.options ?? [])
          : []
      : [];
  const links = actions
    .map((action) => {
      const url = deps.approvalLink(waitId, action, ttlMs);
      return url ? `${action}: ${url}` : null;
    })
    .filter(Boolean);

  const text = [
    `[${run.definition.name}] ${spec.prompt ?? 'Input needed'}`,
    hint,
    ...links,
    `(${waitId})`,
  ].join('\n');

  const choices =
    node && node.type === 'human'
      ? node.kind === 'approve'
        ? [
            { label: 'Approve', data: `wf:${waitId}:a` },
            { label: 'Reject', data: `wf:${waitId}:r` },
          ]
        : (node.options ?? []).map((option, i) => ({
            label: option,
            data: `wf:${waitId}:${i}`,
          }))
      : [];

  const targets = spec.targets?.length ? spec.targets : [undefined];
  for (const to of targets) {
    try {
      await deps.send({
        folder,
        to,
        text,
        choices: choices.length ? choices : undefined,
        stepKey: `${run.id}:${nodeId}:wait`,
      });
    } catch (err) {
      logger.warn({ err, waitId, to }, 'workflow: wait notification failed');
    }
  }
}

function openWait(
  run: RunRow,
  nodeId: string,
  attempt: number,
  spec: WaitSpec,
): string {
  const id = newId('wait');
  insertWait({
    id,
    run_id: run.id,
    node_id: nodeId,
    attempt,
    kind: spec.kind,
    prompt: spec.prompt ?? null,
    options: spec.options ?? null,
    targets: spec.targets ?? null,
    fields: spec.fields,
    event_type: spec.event_type ?? null,
    filter: spec.filter ?? null,
    event_floor: spec.event_floor ?? null,
    resume_at: spec.resume_at ?? null,
    on_timeout: spec.on_timeout,
  });
  return id;
}

function stepForWait(wait: WaitRow): StepRow | undefined {
  return listSteps(wait.run_id).find(
    (s) => s.node_id === wait.node_id && s.attempt === wait.attempt,
  );
}

export function defaultPortFor(node: WorkflowNode): string {
  const ports = portsOf(node);
  return ports[0];
}

function portForResponse(node: WorkflowNode, response: unknown): string {
  if (node.type !== 'human') return DEFAULT_PORT;
  if (node.kind === 'approve') {
    const approved =
      typeof response === 'boolean'
        ? response
        : Boolean((response as { approved?: unknown } | null)?.approved);
    return approved ? 'approved' : 'rejected';
  }
  if (node.kind === 'choice') {
    const choice =
      typeof response === 'string'
        ? response
        : String((response as { choice?: unknown } | null)?.choice ?? '');
    return node.options?.includes(choice) ? choice : 'timeout';
  }
  return 'submitted';
}

export async function resolveWait(
  waitId: string,
  response: unknown,
  responder: string | null,
  via: string,
): Promise<void> {
  const wait = getWait(waitId);
  if (!wait || wait.status !== 'open') return;
  const run = getRun(wait.run_id);
  if (!run) return;
  const node = run.definition.nodes[wait.node_id];
  if (!node) return;

  closeWait(waitId, {
    status: 'resolved',
    response,
    responder,
    responded_via: via,
  });

  const step = stepForWait(wait);
  const output =
    wait.kind === 'human'
      ? { response, responder, responded_via: via }
      : response;

  // A sub-run that failed comes back through the node's error port, not as a
  // success carrying a failure payload.
  if (node.type === 'workflow') {
    const status = (response as { status?: string } | null)?.status;
    const ok = status === 'succeeded' || status === 'skipped';
    const hasErrorEdge = run.definition.edges.some(
      (e) => e.from === wait.node_id && e.port === ERROR_PORT,
    );
    if (step)
      updateStep(step.id, {
        status: ok ? 'succeeded' : 'failed',
        port: ok ? DEFAULT_PORT : hasErrorEdge ? ERROR_PORT : null,
        output: storeOutput(run.id, wait.node_id, wait.attempt, output),
        error: ok
          ? null
          : `sub-run ${(response as { run_id?: string } | null)?.run_id ?? ''} ${status ?? 'failed'}`,
        finished_at: new Date().toISOString(),
      });
    appendRunEvent(run.id, 'wait.resolved', wait.node_id, {
      wait_id: waitId,
      via,
      port: ok ? DEFAULT_PORT : ERROR_PORT,
    });
    await advance(run.id);
    return;
  }

  const port =
    wait.kind === 'event'
      ? 'received'
      : wait.kind === 'delay'
        ? DEFAULT_PORT
        : portForResponse(node, response);

  if (step)
    updateStep(step.id, {
      status: 'succeeded',
      port,
      output: storeOutput(run.id, wait.node_id, wait.attempt, output),
      finished_at: new Date().toISOString(),
    });
  appendRunEvent(run.id, 'wait.resolved', wait.node_id, {
    wait_id: waitId,
    via,
    port,
  });
  webBroker.publishWorkflow({
    type: 'wait.resolved',
    runId: run.id,
    slug: run.slug,
    nodeId: wait.node_id,
    waitId,
    via,
    ts: Date.now(),
  });
  await advance(run.id);
}

async function expireWait(wait: WaitRow): Promise<void> {
  const run = getRun(wait.run_id);
  if (!run) return;
  const node = run.definition.nodes[wait.node_id];
  if (!node) return;
  const step = stepForWait(wait);
  closeWait(wait.id, { status: 'expired', responded_via: 'timeout' });
  appendRunEvent(run.id, 'wait.expired', wait.node_id, { wait_id: wait.id });

  const hasTimeoutEdge = run.definition.edges.some(
    (e) => e.from === wait.node_id && e.port === 'timeout',
  );
  const onTimeout = wait.on_timeout as
    | string
    | { value: unknown }
    | null
    | undefined;

  const finishStep = (patch: Parameters<typeof updateStep>[1]) => {
    if (step)
      updateStep(step.id, { ...patch, finished_at: new Date().toISOString() });
  };

  if (hasTimeoutEdge) {
    finishStep({ status: 'succeeded', port: 'timeout', output: null });
  } else if (
    onTimeout &&
    typeof onTimeout === 'object' &&
    'value' in onTimeout
  ) {
    finishStep({
      status: 'succeeded',
      port: defaultPortFor(node),
      output: storeOutput(run.id, wait.node_id, wait.attempt, onTimeout.value),
    });
  } else if (onTimeout === 'approve') {
    finishStep({ status: 'succeeded', port: 'approved', output: null });
  } else if (onTimeout === 'reject') {
    finishStep({ status: 'succeeded', port: 'rejected', output: null });
  } else if (onTimeout === 'skip') {
    finishStep({ status: 'skipped', output: null });
  } else {
    const hasErrorEdge = run.definition.edges.some(
      (e) => e.from === wait.node_id && e.port === ERROR_PORT,
    );
    finishStep({
      status: 'failed',
      port: hasErrorEdge ? ERROR_PORT : null,
      error: 'wait expired',
    });
  }
  await advance(run.id);
}

// ─── forking ────────────────────────────────────────────────────────────────

function ancestorsOf(def: WorkflowDefinition, target: string): Set<string> {
  const parents = new Map<string, string[]>();
  for (const e of def.edges) {
    const list = parents.get(e.to) ?? [];
    list.push(e.from);
    parents.set(e.to, list);
  }
  const seen = new Set<string>();
  const queue = [...(parents.get(target) ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const p of parents.get(id) ?? []) queue.push(p);
  }
  return seen;
}

// Retry-from-a-node is a fork, never a rewind: a new run copies the completed
// steps of the target's ancestors and starts the decider there. The parent run
// keeps its history.
export async function forkRun(
  runId: string,
  fromNode: string,
  overrideOutput?: { node: string; output: unknown },
): Promise<string> {
  const parent = getRun(runId);
  if (!parent) throw new Error(`unknown run: ${runId}`);
  const def = parent.definition;
  if (!def.nodes[fromNode]) throw new Error(`unknown node: ${fromNode}`);

  const id = newId('run');
  insertRun({
    id,
    slug: parent.slug,
    trigger_id: parent.trigger_id,
    definition: def,
    definition_hash: parent.definition_hash,
    inputs: parent.inputs,
    trigger_payload: parent.trigger_payload,
    status: 'running',
    parent_run_id: parent.id,
    forked_at_node: fromNode,
  });
  updateRun(id, { context: { ...parent.context } });

  const ancestors = ancestorsOf(def, fromNode);
  for (const step of latestSteps(listSteps(parent.id)).values()) {
    if (!ancestors.has(step.node_id) || step.status !== 'succeeded') continue;
    const copied = insertStep({
      run_id: id,
      node_id: step.node_id,
      attempt: 1,
      status: 'running',
      input: { forked_from: parent.id },
    });
    const output =
      overrideOutput && overrideOutput.node === step.node_id
        ? storeOutput(id, step.node_id, 1, overrideOutput.output)
        : step.output;
    updateStep(copied, {
      status: 'succeeded',
      port: step.port,
      output,
      agent_session_id: step.agent_session_id,
      finished_at: step.finished_at,
    });
  }

  appendRunEvent(id, 'run.forked', fromNode, { parent: parent.id });
  publishRun(id, parent.slug, 'running');
  await advance(id);
  return id;
}

// ─── ticks and recovery ─────────────────────────────────────────────────────

// One coarse scan: delay timers, expiring waits, and event waits matched
// against the persisted event log.
export async function tick(): Promise<void> {
  for (const wait of listOpenWaits('event')) {
    const match = deps.findEvent(wait.event_type!, wait.filter, {
      afterId: wait.event_floor ?? undefined,
    });
    if (match) await resolveWait(wait.id, match.payload, null, 'event');
  }

  const now = deps.now().toISOString();
  for (const wait of listDueWaits(now)) {
    if (wait.kind === 'delay') {
      await resolveWait(wait.id, { slept_until: now }, null, 'timer');
    } else {
      await expireWait(wait);
    }
  }

  for (const run of listRunsByStatus(['queued'])) {
    await startNextQueued(run.slug);
  }
}

// Steps left mid-flight by a restart are re-dispatched under their retry
// policy; waits are untouched because their rows already hold the state.
export async function recover(): Promise<void> {
  const runs = listRunsByStatus(['running', 'waiting']);
  for (const run of runs) {
    for (const step of listSteps(run.id)) {
      if (step.status === 'running')
        updateStep(step.id, {
          status: 'interrupted',
          error: 'interrupted by restart',
          finished_at: new Date().toISOString(),
        });
    }
    appendRunEvent(run.id, 'run.recovered', null, undefined);
  }
  for (const run of runs) await advance(run.id);
}
