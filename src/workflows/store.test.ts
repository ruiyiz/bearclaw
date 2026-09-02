import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The workflows directory has to be redirected before config.ts is evaluated,
// so this file imports everything dynamically.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bearclaw-workflows-'));
process.env.BEARCLAW_WORKFLOWS_DIR = tmpDir;
process.env.NODE_ENV = 'test';

const { initDatabase } = await import('../db.js');
initDatabase(':memory:');
const { getWorkflowRow, listWorkflowRows } = await import('./db.js');
const {
  deleteWorkflow,
  syncWorkflowFiles,
  watchWorkflowFiles,
  writeWorkflowFile,
} = await import('./store.js');

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

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

function writeRaw(name: string, body: unknown): void {
  fs.writeFileSync(path.join(tmpDir, name), JSON.stringify(body, null, 2));
}

test('syncWorkflowFiles indexes valid files and reports invalid ones', () => {
  writeRaw('reminder.json', DEF);
  writeRaw('broken.json', { name: 'Broken', slug: 'broken', owner: 'main' });
  writeRaw('mismatch.json', { ...DEF, slug: 'other' });

  const report = syncWorkflowFiles();
  assert.deepEqual(report.loaded, ['reminder']);
  assert.equal(report.errors.length, 2);
  assert.ok(
    report.errors.some((e) =>
      e.issues.some((i) => i.includes('does not match filename')),
    ),
  );

  const row = getWorkflowRow('reminder');
  assert.equal(row?.owner, 'main');
  assert.equal(row?.definition.nodes.deliver.type, 'send');
  assert.ok(row?.file_hash);
});

test('writeWorkflowFile validates, writes and indexes', () => {
  const written = writeWorkflowFile({
    ...DEF,
    slug: 'checkin',
    name: 'Check-in',
    nodes: { ping: { type: 'agent', prompt: 'anything to flag?' } },
  } as never);
  assert.equal(written.slug, 'checkin');
  assert.ok(fs.existsSync(path.join(tmpDir, 'checkin.json')));
  assert.equal(getWorkflowRow('checkin')?.name, 'Check-in');

  assert.throws(
    () => writeWorkflowFile({ ...DEF, nodes: {}, slug: 'empty' } as never),
    /invalid workflow graph/,
  );
});

test('a file that disappears drops out of the index', () => {
  fs.unlinkSync(path.join(tmpDir, 'reminder.json'));
  const report = syncWorkflowFiles();
  assert.deepEqual(report.removed, ['reminder']);
  assert.equal(getWorkflowRow('reminder'), undefined);
  assert.deepEqual(
    listWorkflowRows().map((r) => r.slug),
    ['checkin'],
  );
});

test('deleteWorkflow removes both the file and the row', () => {
  assert.equal(deleteWorkflow('checkin'), true);
  assert.equal(fs.existsSync(path.join(tmpDir, 'checkin.json')), false);
  assert.equal(deleteWorkflow('checkin'), false);
});

test('the watcher reloads on its own, with or without a callback', async () => {
  const stop = watchWorkflowFiles();
  try {
    writeRaw('watched.json', { ...DEF, slug: 'watched', name: 'Watched' });
    // Debounced inside the watcher; poll rather than guess a sleep.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !getWorkflowRow('watched'))
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(getWorkflowRow('watched')?.name, 'Watched');
  } finally {
    stop();
  }
});
