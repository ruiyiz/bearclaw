import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, beforeEach, test } from 'node:test';

import type { AgentRegistry } from '../types.js';
import {
  agentExists,
  createAgent,
  deleteAgent,
  listAgents,
  loadRegistry,
  saveRegistry,
} from './agents.js';
import { getConfigDb } from './config-db.js';
import { getContextFile, listContextFiles } from './context.js';
import { agentVarDir } from './paths.js';
import { withTempHome } from './testing.js';

const home = withTempHome('bearclaw-agents-');
after(() => home.dispose());

beforeEach(() => {
  getConfigDb().exec('DELETE FROM agents; DELETE FROM context_files;');
});

const REGISTRY: AgentRegistry = {
  main: {
    name: 'Andy',
    channels: {
      web: { added_at: '2026-01-01T00:00:00.000Z' },
      'tg:42': {
        added_at: '2026-01-01T00:00:00.000Z',
        trigger: '',
        primary: true,
      },
    },
    heartbeat: { interval: '2h' },
  },
  // A folder with nothing wired to it: created in the UI, or unwired later.
  spare: { name: 'Spare', channels: {} },
};

test('the registry survives a save/load round trip', () => {
  saveRegistry(REGISTRY);
  assert.deepEqual(loadRegistry(), REGISTRY);
  assert.deepEqual(listAgents(), ['main', 'spare']);
});

test('saveRegistry leaves rows that are absent from the registry alone', () => {
  saveRegistry(REGISTRY);
  saveRegistry({ main: { name: 'Renamed', channels: {} } });
  const after = loadRegistry();
  assert.equal(after.main.name, 'Renamed');
  assert.deepEqual(after.main.channels, {});
  assert.ok(after.spare, 'the untouched folder still has a row');
});

test('createAgent seeds a stub identity and an empty channels map', () => {
  createAgent('coco', 'Coco');
  assert.ok(agentExists('coco'));
  assert.deepEqual(loadRegistry().coco.channels, {});
  const identity = getContextFile('agent', 'coco', 'IDENTITY.md');
  assert.match(identity ?? '', /^# Coco/);
});

test('createAgent copies the template folder context rows', () => {
  createAgent('coco', 'Coco');
  getConfigDb()
    .prepare(
      "INSERT INTO context_files (scope, folder, name, content, updated_at) VALUES ('agent', 'coco', 'HEARTBEAT.md', 'look around', ?)",
    )
    .run(new Date().toISOString());

  createAgent('nova', 'Nova', { template: 'coco' });
  assert.equal(getContextFile('agent', 'nova', 'HEARTBEAT.md'), 'look around');
  assert.match(getContextFile('agent', 'nova', 'IDENTITY.md') ?? '', /^# Coco/);
});

test('createAgent refuses a duplicate folder and a missing template', () => {
  createAgent('coco', 'Coco');
  assert.throws(() => createAgent('coco', 'Coco'), /already exists/);
  assert.throws(
    () => createAgent('nova', 'Nova', { template: 'ghost' }),
    /not found/,
  );
  assert.throws(() => createAgent('has space', 'Nope'), /invalid folder/);
});

test('deleteAgent drops the row and its context, and refuses main', () => {
  saveRegistry(REGISTRY);
  createAgent('coco', 'Coco');
  const varDir = agentVarDir('coco');
  assert.ok(fs.existsSync(varDir), 'createAgent laid out the var directory');

  deleteAgent('coco', { includeVar: true });
  assert.equal(agentExists('coco'), false);
  assert.equal(getContextFile('agent', 'coco', 'IDENTITY.md'), undefined);
  assert.equal(fs.existsSync(varDir), false);
  assert.ok(!listContextFiles().agents.some((a) => a.folder === 'coco'));

  assert.throws(() => deleteAgent('main'), /cannot delete main/);
  assert.ok(agentExists('main'));
});
