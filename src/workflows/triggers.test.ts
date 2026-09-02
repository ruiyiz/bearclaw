import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { initDatabase, emitEvent } from '../db.js';
import {
  getTriggerRow,
  getRun,
  listRuns,
  listTriggerRows,
  setWorkflowEnabled,
  upsertWorkflowIndex,
} from './db.js';
import { setEngineDeps } from './engine.js';
import { parseDefinition, type WorkflowDefinition } from './schema.js';
import { makeFakeDeps, type FakeDeps } from './testing.js';
import {
  TriggerError,
  createTrigger,
  deleteTrigger,
  dispatchEvents,
  findWebhookTrigger,
  nextCronRun,
  scanDueTriggers,
  setTriggerEnabled,
  syncFileTriggers,
} from './triggers.js';

initDatabase(':memory:');

let fake: FakeDeps;

beforeEach(() => {
  fake = makeFakeDeps();
  setEngineDeps(fake);
});

function register(partial: Record<string, unknown>): WorkflowDefinition {
  const def = parseDefinition({
    name: 'Test',
    slug: 'test',
    owner: 'main',
    nodes: { note: { type: 'transform', expr: 'inputs' } },
    edges: [],
    ...partial,
  });
  upsertWorkflowIndex({
    slug: def.slug,
    name: def.name,
    owner: def.owner,
    definition: def,
  });
  return def;
}

test('file-declared triggers are owned by the loader', () => {
  const def = register({
    slug: 'nightly',
    triggers: [
      { id: 'cron', type: 'cron', cron: '0 20 * * *' },
      { id: 'manual', type: 'manual' },
    ],
  });
  syncFileTriggers(def);

  const ids = listTriggerRows('nightly').map((t) => t.id);
  assert.deepEqual(ids.sort(), ['nightly:cron', 'nightly:manual']);
  const cron = getTriggerRow('nightly:cron')!;
  assert.equal(cron.source, 'file');
  assert.ok(cron.next_run_at);

  // A trigger dropped from the file disappears; a runtime trigger survives.
  createTrigger({ slug: 'nightly', type: 'webhook' });
  const trimmed = register({
    slug: 'nightly',
    triggers: [{ id: 'cron', type: 'cron', cron: '0 20 * * *' }],
  });
  syncFileTriggers(trimmed);
  const after = listTriggerRows('nightly');
  assert.equal(after.filter((t) => t.source === 'file').length, 1);
  assert.equal(after.filter((t) => t.source === 'runtime').length, 1);
});

test('a paused file trigger stays paused across reloads', () => {
  const def = register({
    slug: 'pausable',
    triggers: [{ id: 'cron', type: 'cron', cron: '0 9 * * *' }],
  });
  syncFileTriggers(def);
  setTriggerEnabled('pausable:cron', false);
  syncFileTriggers(def);
  assert.equal(getTriggerRow('pausable:cron')?.enabled, false);
});

test('trigger args are validated against the workflow inputs schema', () => {
  register({
    slug: 'typed',
    inputs: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string' },
        limit: { type: 'integer', default: 5 },
      },
    },
  });

  const trigger = createTrigger({
    slug: 'typed',
    type: 'manual',
    args: { text: 'hello' },
  });
  assert.deepEqual(trigger.args, { text: 'hello', limit: 5 });

  assert.throws(
    () => createTrigger({ slug: 'typed', type: 'manual', args: {} }),
    /text is required/,
  );
  assert.throws(
    () => createTrigger({ slug: 'missing', type: 'manual' }),
    TriggerError,
  );
  assert.throws(
    () =>
      createTrigger({
        slug: 'typed',
        type: 'cron',
        config: {},
        args: { text: 'x' },
      }),
    /needs a cron field/,
  );
});

test('a due cron trigger fires and advances to the next slot', async () => {
  register({ slug: 'cronny' });
  const trigger = createTrigger({
    slug: 'cronny',
    type: 'cron',
    config: { cron: '0 * * * *', timezone: 'UTC' },
  });
  assert.equal(
    trigger.next_run_at,
    nextCronRun('0 * * * *', fake.clock, 'UTC'),
  );

  fake.clock = new Date('2026-09-02T03:05:00.000Z');
  await scanDueTriggers();

  const runs = listRuns('cronny');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'succeeded');
  assert.equal(runs[0].trigger_id, trigger.id);

  const after = getTriggerRow(trigger.id)!;
  assert.equal(after.last_run_id, runs[0].id);
  assert.ok(after.next_run_at! > fake.clock.toISOString());
});

test('catch-up skip collapses missed slots into one firing', async () => {
  register({ slug: 'missed' });
  const trigger = createTrigger({
    slug: 'missed',
    type: 'cron',
    config: { cron: '0 * * * *', timezone: 'UTC', catchup: 'skip' },
  });

  // Six hours of downtime.
  fake.clock = new Date('2026-09-02T09:05:00.000Z');
  await scanDueTriggers();
  assert.equal(listRuns('missed').length, 0);
  assert.ok(getTriggerRow(trigger.id)!.next_run_at! > fake.clock.toISOString());
});

test('catch-up all replays every missed slot', async () => {
  register({ slug: 'replay' });
  createTrigger({
    slug: 'replay',
    type: 'cron',
    config: { cron: '0 * * * *', timezone: 'UTC', catchup: 'all' },
  });
  fake.clock = new Date('2026-09-02T05:05:00.000Z');
  await scanDueTriggers();
  assert.equal(listRuns('replay').length, 3);
});

test('a quiet window suppresses the slots inside it', async () => {
  register({ slug: 'quiet' });
  createTrigger({
    slug: 'quiet',
    type: 'cron',
    config: {
      cron: '0 * * * *',
      timezone: 'UTC',
      catchup: 'all',
      quiet: { start: '02:00', end: '05:00' },
    },
  });
  fake.clock = new Date('2026-09-02T06:05:00.000Z');
  await scanDueTriggers();
  // Slots at 03:00 and 04:00 fall inside the window and are dropped.
  const fired = listRuns('quiet').map(
    (r) => (r.trigger_payload as { fired_at: string }).fired_at,
  );
  assert.deepEqual(fired.sort(), [
    '2026-09-02T05:00:00.000Z',
    '2026-09-02T06:00:00.000Z',
  ]);
});

test('an at trigger fires once and disables itself', async () => {
  register({ slug: 'oneshot' });
  const trigger = createTrigger({
    slug: 'oneshot',
    type: 'at',
    config: { at: '2026-09-02T02:30:00.000Z' },
  });

  fake.clock = new Date('2026-09-02T02:31:00.000Z');
  await scanDueTriggers();
  assert.equal(listRuns('oneshot').length, 1);

  const after = getTriggerRow(trigger.id)!;
  assert.equal(after.enabled, false);
  assert.equal(after.next_run_at, null);

  fake.clock = new Date('2026-09-02T03:31:00.000Z');
  await scanDueTriggers();
  assert.equal(listRuns('oneshot').length, 1);
});

test('event triggers match on filter and map the payload into inputs', async () => {
  register({
    slug: 'listener',
    inputs: {
      type: 'object',
      properties: { batch: { type: 'string' } },
    },
  });
  createTrigger({
    slug: 'listener',
    type: 'event',
    config: {
      event: 'newsletter_queue_empty',
      filter: { queue: 'main' },
      map: { batch: 'batch_id' },
    },
  });

  emitEvent('newsletter_queue_empty', { queue: 'other', batch_id: 'b1' });
  emitEvent('newsletter_queue_empty', { queue: 'main', batch_id: 'b2' });
  emitEvent('unrelated', { queue: 'main' });
  await dispatchEvents();

  const runs = listRuns('listener');
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].inputs, { batch: 'b2' });

  // Events are marked processed, so a second pass does not refire.
  await dispatchEvents();
  assert.equal(listRuns('listener').length, 1);
});

test('a webhook trigger is found by its token, and the token is shown once', () => {
  register({ slug: 'hooked' });
  const trigger = createTrigger({ slug: 'hooked', type: 'webhook' });
  const token = trigger.config.token as string;
  assert.ok(token);
  assert.equal(findWebhookTrigger(token)?.id, trigger.id);
  assert.equal(findWebhookTrigger('wrong-token'), undefined);
  assert.equal(getTriggerRow(trigger.id)?.config.token, undefined);
});

test('a file-declared trigger cannot be deleted through the API', () => {
  const def = register({
    slug: 'filebound',
    triggers: [{ id: 'cron', type: 'cron', cron: '0 8 * * *' }],
  });
  syncFileTriggers(def);
  assert.throws(
    () => deleteTrigger('filebound:cron'),
    /declared in the workflow file/,
  );

  const runtime = createTrigger({ slug: 'filebound', type: 'manual' });
  deleteTrigger(runtime.id);
  assert.equal(getTriggerRow(runtime.id), undefined);
});

test('a disabled workflow does not fire', async () => {
  register({ slug: 'off' });
  setWorkflowEnabled('off', false);
  createTrigger({
    slug: 'off',
    type: 'at',
    config: { at: '2026-09-02T02:10:00.000Z' },
  });
  fake.clock = new Date('2026-09-02T02:20:00.000Z');
  await scanDueTriggers();
  assert.equal(listRuns('off').length, 0);
});

test('a run records the trigger that fired it', async () => {
  register({ slug: 'attributed' });
  const trigger = createTrigger({
    slug: 'attributed',
    type: 'at',
    config: { at: '2026-09-02T02:05:00.000Z' },
    args: {},
  });
  fake.clock = new Date('2026-09-02T02:06:00.000Z');
  await scanDueTriggers();
  const run = getRun(listRuns('attributed')[0].id)!;
  assert.equal(run.trigger_id, trigger.id);
  assert.equal(run.context.__trigger_type as string, 'at');
});
