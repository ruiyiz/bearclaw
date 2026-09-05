import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

import { createAgent } from '../store/agents.js';
import { getConfigDb } from '../store/config-db.js';
import { getContextFile, writeContextFile } from '../store/context.js';
import { withTempHome } from '../store/testing.js';
import {
  MAX_CONTEXT_BYTES,
  contextList,
  contextRead,
  contextWrite,
  type ContextToolCtx,
} from './context-tools.js';

const home = withTempHome('bearclaw-ctxtools-');
after(() => home.dispose());

const MAIN: ContextToolCtx = { agentFolder: 'main', isMain: true };
const COCO: ContextToolCtx = { agentFolder: 'coco', isMain: false };

beforeEach(() => {
  getConfigDb().exec('DELETE FROM agents; DELETE FROM context_files;');
  createAgent('main', 'Andy');
  createAgent('coco', 'Coco');
  writeContextFile('shared', null, 'USER.md', '# You\n');
});

test('any agent may read shared context', () => {
  assert.equal(
    contextRead(COCO, { scope: 'shared', name: 'USER.md' }),
    '# You\n',
  );
  assert.equal(
    contextRead(MAIN, { scope: 'shared', name: 'USER.md' }),
    '# You\n',
  );
  assert.throws(
    () => contextRead(COCO, { scope: 'shared', name: 'GONE.md' }),
    /no such file/,
  );
});

test('agent scope defaults to the caller and is fenced for non-main agents', () => {
  assert.match(
    contextRead(COCO, { scope: 'agent', name: 'IDENTITY.md' }),
    /^# Coco/,
  );
  assert.throws(
    () =>
      contextRead(COCO, {
        scope: 'agent',
        name: 'IDENTITY.md',
        folder: 'main',
      }),
    /not allowed to read/,
  );
  assert.match(
    contextRead(MAIN, { scope: 'agent', name: 'IDENTITY.md', folder: 'coco' }),
    /^# Coco/,
  );
});

test('only the main agent writes shared context', () => {
  assert.throws(
    () =>
      contextWrite(COCO, { scope: 'shared', name: 'USER.md', content: 'nope' }),
    /only the main agent/,
  );
  contextWrite(MAIN, {
    scope: 'shared',
    name: 'USER.md',
    content: 'likes tea',
  });
  assert.equal(getContextFile('shared', '', 'USER.md'), '# You\nlikes tea');
});

test('a non-main agent writes only its own folder', () => {
  contextWrite(COCO, {
    scope: 'agent',
    name: 'IDENTITY.md',
    content: 'more',
    mode: 'append',
  });
  assert.match(getContextFile('agent', 'coco', 'IDENTITY.md') ?? '', /more$/);
  assert.throws(
    () =>
      contextWrite(COCO, {
        scope: 'agent',
        name: 'IDENTITY.md',
        content: 'x',
        folder: 'main',
      }),
    /not allowed to write/,
  );
});

test('append is the default and replace overwrites', () => {
  const reply = contextWrite(MAIN, {
    scope: 'shared',
    name: 'USER.md',
    content: 'a note',
  });
  assert.match(reply, /Appended to USER\.md/);
  assert.match(reply, /next turn/);
  assert.equal(getContextFile('shared', '', 'USER.md'), '# You\na note');

  contextWrite(MAIN, {
    scope: 'shared',
    name: 'USER.md',
    content: 'fresh',
    mode: 'replace',
  });
  assert.equal(getContextFile('shared', '', 'USER.md'), 'fresh');
});

test('the size cap is enforced on the resulting file', () => {
  assert.throws(
    () =>
      contextWrite(MAIN, {
        scope: 'shared',
        name: 'USER.md',
        content: 'x'.repeat(MAX_CONTEXT_BYTES + 1),
        mode: 'replace',
      }),
    /exceed/,
  );
  assert.equal(getContextFile('shared', '', 'USER.md'), '# You\n');
});

test('the listing hides other agents from a non-main caller', () => {
  const mine = contextList(COCO);
  assert.match(mine, /agent coco:/);
  assert.ok(!mine.includes('agent main:'));
  assert.match(mine, /USER\.md/);

  const all = contextList(MAIN);
  assert.match(all, /agent coco:/);
  assert.match(all, /agent main:/);
});
