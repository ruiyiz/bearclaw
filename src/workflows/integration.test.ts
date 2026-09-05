import assert from 'node:assert/strict';
import { after, test } from 'node:test';

// Exercises the real definition loader, the real trigger table and the real
// shell executor end to end against in-memory databases.
process.env.NODE_ENV = 'test';

const { closeConfigDb, initConfigDb } = await import('../store/config-db.js');
initConfigDb(':memory:');
const { putWorkflowDefinition } = await import('../store/workflows.js');

const { initDatabase } = await import('../db.js');
initDatabase(':memory:');

const { getRun, listRuns, listSteps, listTriggerRows } =
  await import('./db.js');
const { syncWorkflowDefinitions } = await import('./store.js');
const { runManually, scanDueTriggers } = await import('./triggers.js');

after(() => closeConfigDb());

const DIGEST = {
  $schema: 'bearclaw://workflow/v1',
  name: 'Digest',
  slug: 'digest',
  owner: 'main',
  inputs: {
    type: 'object',
    properties: { limit: { type: 'integer', default: 2 } },
  },
  triggers: [
    { id: 'nightly', type: 'cron', cron: '0 20 * * *' },
    { id: 'manual', type: 'manual' },
  ],
  policies: { concurrency: 'skip' },
  nodes: {
    fetch: {
      type: 'shell',
      cmd: 'printf \'[{"id":1,"title":"one"},{"id":2,"title":"two"},{"id":3,"title":"three"}]\'',
      parse: 'json',
    },
    limited: {
      type: 'transform',
      expr: 'nodes.fetch.output.slice(0, inputs.limit)',
    },
    any: { type: 'condition', expr: 'nodes.limited.output.length > 0' },
    render: {
      type: 'template',
      template: "ids: {{join nodes.limited.output.*.id ', '}}",
    },
    mark: {
      type: 'shell',
      cmd: "echo marked {{join nodes.limited.output.*.id ' '}}",
    },
    caught_up: { type: 'transform', expr: '"nothing to do"' },
  },
  edges: [
    { from: 'fetch', to: 'limited' },
    { from: 'limited', to: 'any' },
    { from: 'any', port: 'true', to: 'render' },
    { from: 'any', port: 'false', to: 'caught_up' },
    { from: 'render', to: 'mark' },
  ],
};

test('a definition row loads, indexes and declares its triggers', () => {
  putWorkflowDefinition('digest', DIGEST);
  const report = syncWorkflowDefinitions();
  assert.deepEqual(report.loaded, ['digest']);
  assert.deepEqual(report.errors, []);

  const triggers = listTriggerRows('digest');
  assert.deepEqual(triggers.map((t) => t.id).sort(), [
    'digest:manual',
    'digest:nightly',
  ]);
  assert.ok(triggers.find((t) => t.id === 'digest:nightly')?.next_run_at);
});

test('a manual run executes real shell nodes and threads their output', async () => {
  const result = await runManually('digest', {}, 'test');
  assert.ok(result.runId);
  const run = getRun(result.runId)!;
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.inputs, { limit: 2 });

  const steps = new Map(listSteps(run.id).map((s) => [s.node_id, s]));
  assert.equal(steps.get('render')?.output, 'ids: 1, 2');
  assert.equal(steps.get('mark')?.output, 'marked 1 2');
  // The false branch never ran, so it never blocked anything.
  assert.equal(steps.has('caught_up'), false);
});

test('inputs passed at run time override the schema default', async () => {
  const result = await runManually('digest', { limit: 3 }, 'test');
  const steps = new Map(listSteps(result.runId!).map((s) => [s.node_id, s]));
  assert.equal(steps.get('render')?.output, 'ids: 1, 2, 3');
});

test('a shell failure fails the run with the command output', async () => {
  putWorkflowDefinition('broken', {
    name: 'Broken',
    slug: 'broken',
    owner: 'main',
    nodes: {
      boom: { type: 'shell', cmd: 'echo bad >&2; exit 3' },
    },
    edges: [],
  });
  syncWorkflowDefinitions();
  const result = await runManually('broken', {}, 'test');
  const run = getRun(result.runId!)!;
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /exit 3/);
  assert.match(run.error ?? '', /bad/);
});

test('the cron trigger fires on its own once its slot passes', async () => {
  const before = listRuns('digest').length;
  const nightly = listTriggerRows('digest').find(
    (t) => t.id === 'digest:nightly',
  )!;
  // Pull the slot into the past the way a restart after downtime would.
  const { updateTriggerRow } = await import('./db.js');
  updateTriggerRow(nightly.id, {
    next_run_at: new Date(Date.now() - 60_000).toISOString(),
  });

  await scanDueTriggers();
  const runs = listRuns('digest');
  assert.equal(runs.length, before + 1);
  assert.equal(runs[0].trigger_id, nightly.id);
  assert.ok(
    listTriggerRows('digest').find((t) => t.id === nightly.id)!.next_run_at! >
      new Date().toISOString(),
  );
});
