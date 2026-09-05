import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

import { createAgent } from './agents.js';
import { getConfigDb } from './config-db.js';
import {
  ContextFileNotFound,
  createContextFile,
  deleteContextFile,
  getContextFile,
  listContextFiles,
  readContextFile,
  writeContextFile,
} from './context.js';
import { ensureAgentVarLayout, materializeContext } from './materialize.js';
import { agentVarDir, contextCacheDir } from './paths.js';
import { withTempHome } from './testing.js';

const home = withTempHome('bearclaw-context-');
after(() => home.dispose());

beforeEach(() => {
  getConfigDb().exec('DELETE FROM agents; DELETE FROM context_files;');
  fs.rmSync(contextCacheDir(), { recursive: true, force: true });
});

const mirror = (...parts: string[]) => path.join(contextCacheDir(), ...parts);

test('a shared file round trips through the store and the mirror', () => {
  createContextFile('shared', null, 'USER.md', '# You\n');
  assert.equal(getContextFile('shared', '', 'USER.md'), '# You\n');
  assert.equal(readContextFile('shared', null, 'USER.md').content, '# You\n');
  assert.equal(
    fs.readFileSync(mirror('shared', 'USER.md'), 'utf-8'),
    '# You\n',
  );

  writeContextFile('shared', null, 'USER.md', '# You\n\nlikes tea\n');
  assert.match(
    fs.readFileSync(mirror('shared', 'USER.md'), 'utf-8'),
    /likes tea/,
  );

  deleteContextFile('shared', null, 'USER.md');
  assert.equal(getContextFile('shared', '', 'USER.md'), undefined);
  assert.equal(fs.existsSync(mirror('shared', 'USER.md')), false);
});

test('agent scope requires a registered folder', () => {
  assert.throws(
    () => createContextFile('agent', 'ghost', 'IDENTITY.md', 'x'),
    /agent folder not found/,
  );
  createAgent('coco', 'Coco');
  writeContextFile('agent', 'coco', 'NOTES.md', 'hi');
  assert.equal(
    fs.readFileSync(mirror('agents', 'coco', 'NOTES.md'), 'utf-8'),
    'hi',
  );
});

test('file names are validated, and the extension set includes templates', () => {
  for (const bad of ['../escape.md', 'no-extension', 'script.sh', '']) {
    assert.throws(
      () => writeContextFile('shared', null, bad, 'x'),
      /invalid filename/,
    );
  }
  for (const good of [
    'USER.md',
    'brief.txt',
    'digest.hbs',
    'page.html',
    'data.json',
  ]) {
    writeContextFile('shared', null, good, 'ok');
  }
  assert.equal(listContextFiles().shared.length, 5);
});

test('create refuses an existing file, read and delete refuse a missing one', () => {
  createContextFile('shared', null, 'SOUL.md', 'a');
  assert.throws(
    () => createContextFile('shared', null, 'SOUL.md', 'b'),
    /already exists/,
  );
  // The HTTP layer keys its 404 off this class, so the type is part of the
  // contract, not just the message.
  assert.throws(
    () => readContextFile('shared', null, 'GONE.md'),
    (err: unknown) =>
      err instanceof ContextFileNotFound && /file not found/.test(String(err)),
  );
  assert.throws(
    () => deleteContextFile('shared', null, 'GONE.md'),
    (err: unknown) => err instanceof ContextFileNotFound,
  );
  // A bad name is still a validation failure, not a missing file.
  assert.throws(
    () => readContextFile('shared', null, 'nope.exe'),
    (err: unknown) =>
      err instanceof Error && !(err instanceof ContextFileNotFound),
  );
});

test('the listing reports every registered folder and the mirror path', () => {
  createAgent('coco', 'Coco');
  createAgent('nova', 'Nova');
  deleteContextFile('agent', 'nova', 'IDENTITY.md');
  createContextFile('shared', null, 'AGENTS.md', 'shared');

  const listing = listContextFiles();
  assert.deepEqual(
    listing.shared.map((f) => f.name),
    ['AGENTS.md'],
  );
  assert.equal(listing.shared[0].path, mirror('shared', 'AGENTS.md'));
  assert.equal(listing.shared[0].size, 6);
  assert.deepEqual(
    listing.agents.map((a) => ({ folder: a.folder, files: a.files.length })),
    [
      { folder: 'coco', files: 1 },
      { folder: 'nova', files: 0 },
    ],
  );
});

test('a full rebuild writes every row and prunes rowless mirror files', () => {
  createAgent('coco', 'Coco');
  createContextFile('shared', null, 'CONTEXT.md', 'ctx');

  const orphanShared = mirror('shared', 'STALE.md');
  const orphanAgent = mirror('agents', 'coco', 'STALE.md');
  fs.writeFileSync(orphanShared, 'old');
  fs.writeFileSync(orphanAgent, 'old');

  fs.rmSync(mirror('shared', 'CONTEXT.md'));
  materializeContext();

  assert.equal(fs.readFileSync(mirror('shared', 'CONTEXT.md'), 'utf-8'), 'ctx');
  assert.equal(fs.existsSync(orphanShared), false);
  assert.equal(fs.existsSync(orphanAgent), false);
});

test('the agent var layout links the mirrors into the agent cwd', () => {
  createAgent('coco', 'Coco');
  ensureAgentVarLayout('coco');
  const dir = agentVarDir('coco');
  assert.ok(fs.statSync(path.join(dir, 'logs')).isDirectory());
  assert.equal(
    fs.realpathSync(path.join(dir, 'context')),
    fs.realpathSync(contextCacheDir()),
  );
  assert.equal(
    fs.readFileSync(
      path.join(dir, 'context', 'agents', 'coco', 'IDENTITY.md'),
      'utf-8',
    ),
    fs.readFileSync(mirror('agents', 'coco', 'IDENTITY.md'), 'utf-8'),
  );
  assert.equal(
    fs.readlinkSync(path.join(dir, '.claude', 'skills')),
    '../../../cache/skills',
  );
  assert.ok(fs.statSync(path.join(dir, '.claude', 'skills')).isDirectory());

  // A link left pointing somewhere else is repaired rather than kept.
  fs.unlinkSync(path.join(dir, 'context'));
  fs.symlinkSync('../../cache/wrong', path.join(dir, 'context'));
  ensureAgentVarLayout('coco');
  assert.equal(
    fs.readlinkSync(path.join(dir, 'context')),
    '../../cache/context',
  );
});
