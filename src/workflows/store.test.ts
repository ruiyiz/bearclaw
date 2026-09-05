import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';

const { closeConfigDb, initConfigDb } = await import('../store/config-db.js');
initConfigDb(':memory:');
const { deleteWorkflowDefinition, putWorkflowDefinition } =
  await import('../store/workflows.js');

const { initDatabase } = await import('../db.js');
initDatabase(':memory:');
const { getWorkflowRow, listTriggerRows, listWorkflowRows, upsertTrigger } =
  await import('./db.js');
const { deleteWorkflow, saveWorkflowDefinition, syncWorkflowDefinitions } =
  await import('./store.js');

after(() => closeConfigDb());

const DEF = {
  name: 'Reminder',
  slug: 'reminder',
  owner: 'main',
  inputs: {
    type: 'object',
    required: ['text'],
    properties: { text: { type: 'string' }, to: { type: 'string' } },
  },
  nodes: {
    deliver: {
      type: 'send',
      text: '{{inputs.text}}',
      to: "{{default inputs.to 'primary'}}",
    },
  },
  edges: [],
};

test('syncWorkflowDefinitions indexes valid rows and reports invalid ones', () => {
  putWorkflowDefinition('reminder', DEF);
  putWorkflowDefinition('broken', {
    name: 'Broken',
    slug: 'broken',
    owner: 'main',
  });
  putWorkflowDefinition('mismatch', { ...DEF, slug: 'other' });

  const report = syncWorkflowDefinitions();
  assert.deepEqual(report.loaded, ['reminder']);
  assert.equal(report.errors.length, 2);
  assert.ok(
    report.errors.some((e) =>
      e.issues.some((i) => i.includes('does not match the row key')),
    ),
  );
  assert.deepEqual(report.errors.map((e) => e.slug).sort(), [
    'broken',
    'mismatch',
  ]);

  const row = getWorkflowRow('reminder');
  assert.equal(row?.owner, 'main');
  assert.equal(row?.definition.nodes.deliver.type, 'send');
});

test('saveWorkflowDefinition validates, stores and indexes', () => {
  const written = saveWorkflowDefinition({
    ...DEF,
    slug: 'checkin',
    name: 'Check-in',
    nodes: { ping: { type: 'agent', prompt: 'anything to flag?' } },
  } as never);
  assert.equal(written.slug, 'checkin');
  assert.equal(getWorkflowRow('checkin')?.name, 'Check-in');

  assert.throws(
    () => saveWorkflowDefinition({ ...DEF, nodes: {}, slug: 'empty' } as never),
    /invalid workflow graph/,
  );
});

test('a definition row that disappears drops out of the index', () => {
  assert.equal(deleteWorkflowDefinition('reminder'), true);
  deleteWorkflowDefinition('broken');
  deleteWorkflowDefinition('mismatch');
  const report = syncWorkflowDefinitions();
  assert.deepEqual(report.removed, ['reminder']);
  assert.equal(getWorkflowRow('reminder'), undefined);
  assert.deepEqual(
    listWorkflowRows().map((r) => r.slug),
    ['checkin'],
  );
});

test('a trigger left behind by a vanished workflow is swept', () => {
  // The pair can drift: the workflow row goes first, and the leftover trigger
  // is then unreachable.
  upsertTrigger({
    id: 'ghost:schedule',
    slug: 'ghost',
    type: 'cron',
    source: 'file',
    config: { cron: '0 7 * * *' },
    args: {},
    enabled: true,
    next_run_at: null,
    created_by: null,
  });
  assert.equal(listTriggerRows('ghost').length, 1);

  const report = syncWorkflowDefinitions();
  assert.deepEqual(report.orphanTriggers, ['ghost']);
  assert.equal(listTriggerRows('ghost').length, 0);

  // A workflow that still has a definition row keeps its triggers.
  assert.ok(getWorkflowRow('checkin'));
  assert.deepEqual(syncWorkflowDefinitions().orphanTriggers, []);
});

test('deleteWorkflow removes both the definition row and the index row', () => {
  assert.equal(deleteWorkflow('checkin'), true);
  assert.equal(getWorkflowRow('checkin'), undefined);
  assert.equal(deleteWorkflow('checkin'), false);
});
