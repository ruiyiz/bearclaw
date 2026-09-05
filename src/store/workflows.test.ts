import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { closeConfigDb, initConfigDb } from './config-db.js';
import {
  deleteWorkflowDefinition,
  getWorkflowDefinition,
  listWorkflowDefinitions,
  putWorkflowDefinition,
} from './workflows.js';

initConfigDb(':memory:');
after(() => closeConfigDb());

test('a definition round-trips as JSON text', () => {
  const written = putWorkflowDefinition('digest', {
    slug: 'digest',
    name: 'Digest',
  });
  assert.equal(written.slug, 'digest');
  const row = getWorkflowDefinition('digest');
  assert.deepEqual(JSON.parse(row!.definition), {
    slug: 'digest',
    name: 'Digest',
  });
  assert.ok(row!.updatedAt);
});

test('a string body is stored verbatim', () => {
  putWorkflowDefinition('raw', '{"slug":"raw","name":"Raw"}');
  assert.equal(
    getWorkflowDefinition('raw')?.definition,
    '{"slug":"raw","name":"Raw"}',
  );
});

test('writing the same slug replaces the row', () => {
  putWorkflowDefinition('digest', { slug: 'digest', name: 'Renamed' });
  const parsed = JSON.parse(getWorkflowDefinition('digest')!.definition) as {
    name: string;
  };
  assert.equal(parsed.name, 'Renamed');
  assert.equal(listWorkflowDefinitions().length, 2);
});

test('rows list in slug order', () => {
  assert.deepEqual(
    listWorkflowDefinitions().map((r) => r.slug),
    ['digest', 'raw'],
  );
});

test('delete reports whether a row was there', () => {
  assert.equal(deleteWorkflowDefinition('raw'), true);
  assert.equal(deleteWorkflowDefinition('raw'), false);
  assert.equal(getWorkflowDefinition('raw'), undefined);
});
