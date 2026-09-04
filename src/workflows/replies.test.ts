import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { initDatabase } from '../db.js';
import { cancelWaitsForRun, listOpenWaits, upsertWorkflowIndex } from './db.js';
import { setEngineDeps, startRun } from './engine.js';
import { parseDefinition, type WorkflowDefinition } from './schema.js';
import { makeFakeDeps, type FakeDeps } from './testing.js';
import {
  describeOpenWaits,
  matchReply,
  openWaitsForChat,
  resolveFromCallback,
  tryResolveFromMessage,
} from './replies.js';

initDatabase(':memory:');

let fake: FakeDeps;

beforeEach(() => {
  fake = makeFakeDeps();
  setEngineDeps(fake);
  // One in-memory database serves the whole file, so a wait left open by an
  // earlier test would count towards the next one's ambiguity check.
  for (const wait of listOpenWaits()) cancelWaitsForRun(wait.run_id);
});

function register(partial: Record<string, unknown>): WorkflowDefinition {
  const def = parseDefinition({
    name: 'Ask',
    slug: 'ask',
    owner: 'main',
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

async function askApproval(slug: string, to?: string[]) {
  const definition = register({
    slug,
    nodes: {
      ask: {
        type: 'human',
        kind: 'approve',
        prompt: 'Send the digest?',
        ...(to ? { to } : {}),
      },
      go: { type: 'transform', expr: '"sent"' },
    },
    edges: [{ from: 'ask', port: 'approved', to: 'go' }],
  });
  const { runId } = await startRun({ slug, definition });
  return listOpenWaits('human').filter((w) => w.run_id === runId);
}

test('a wait with no targets belongs to the owning agent chats', async () => {
  await askApproval('untargeted');
  assert.equal(openWaitsForChat('tg:1', 'main').length, 1);
  assert.equal(openWaitsForChat('tg:1', 'coco').length, 0);
});

test('a targeted wait only matches its target', async () => {
  await askApproval('targeted', ['imsg:17']);
  const mine = openWaitsForChat('imsg:17', 'coco');
  assert.equal(mine.length, 1);
  assert.equal(
    openWaitsForChat('tg:1', 'main').filter((w) => w.id === mine[0].id).length,
    0,
  );
});

test('yes and no resolve an approval, anything else does not', async () => {
  const waits = await askApproval('yesno');
  assert.deepEqual(matchReply(waits, 'yes')?.response, { approved: true });
  assert.deepEqual(matchReply(waits, 'Reject')?.response, { approved: false });
  assert.equal(matchReply(waits, 'save 1 4, summarize 7'), null);
});

test('a human prompt can name its own wait, and the reply routes by it', async () => {
  // notify:false means the engine sends nothing, so the workflow's own message
  // is the only thing the user sees. {{wait.id}} lets it carry a return
  // address — and a run can have two questions open at once, so the run id
  // would not be enough to tell them apart.
  const definition = register({
    slug: 'self-identifying',
    nodes: {
      ask_a: {
        type: 'human',
        kind: 'approve',
        notify: false,
        prompt: 'Branch A? Reply quoting {{wait.id}}',
      },
      ask_b: {
        type: 'human',
        kind: 'approve',
        notify: false,
        prompt: 'Branch B? Reply quoting {{wait.id}}',
      },
      done_a: { type: 'transform', expr: '"a"' },
      done_b: { type: 'transform', expr: '"b"' },
    },
    edges: [
      { from: 'ask_a', port: 'approved', to: 'done_a' },
      { from: 'ask_b', port: 'approved', to: 'done_b' },
    ],
  });
  const { runId } = await startRun({ slug: 'self-identifying', definition });

  // Both branches park in the same pass, under one run id.
  const waits = listOpenWaits('human').filter((w) => w.run_id === runId);
  assert.equal(waits.length, 2);
  assert.equal(new Set(waits.map((w) => w.run_id)).size, 1);

  // Each prompt names the wait it belongs to, not some other one.
  for (const wait of waits)
    assert.match(wait.prompt ?? '', new RegExp(wait.id));

  // Naming that id resolves exactly that branch, never the other one.
  const b = waits.find((w) => w.node_id === 'ask_b')!;
  const match = matchReply(waits, `yes ${b.id}`);
  assert.equal(match?.wait.id, b.id);
  assert.deepEqual(match?.response, { approved: true });

  // A quoted email reply routes to the right wait but does not auto-resolve:
  // the quoted digest is still in the body, so it is not an exact answer and
  // goes to the agent, which now has an unambiguous id to hand to
  // workflow_respond.
  assert.equal(
    matchReply(waits, `yes\n\n> Branch B? Reply quoting ${b.id}`),
    null,
  );
});

test('a bare answer is refused while more than one question is open', async () => {
  // Two concurrent digests, each parked on its own question. "yes" belongs to
  // neither in particular, so it goes to the agent instead of the older one.
  const first = await askApproval('two-open-a');
  const second = await askApproval('two-open-b');
  const both = [...first, ...second];
  assert.equal(both.length, 2);
  assert.equal(matchReply(both, 'yes'), null);

  // Naming a wait still resolves that one, and only that one.
  const named = matchReply(both, `yes ${second[0].id}`);
  assert.equal(named?.wait.id, second[0].id);
  assert.deepEqual(named?.response, { approved: true });

  // One question open is unambiguous, so the bare answer still works.
  assert.deepEqual(matchReply(first, 'yes')?.response, { approved: true });
});

test('a choice wait matches its option labels exactly', async () => {
  const definition = register({
    slug: 'pick',
    nodes: {
      ask: {
        type: 'human',
        kind: 'choice',
        prompt: 'Which one?',
        options: ['red', 'blue'],
      },
      red: { type: 'transform', expr: '"red"' },
      blue: { type: 'transform', expr: '"blue"' },
    },
    edges: [
      { from: 'ask', port: 'red', to: 'red' },
      { from: 'ask', port: 'blue', to: 'blue' },
    ],
  });
  const { runId } = await startRun({ slug: 'pick', definition });
  const waits = openWaitsForChat('tg:1', 'main').filter(
    (w) => w.run_id === runId,
  );
  assert.deepEqual(matchReply(waits, 'BLUE')?.response, { choice: 'blue' });
  assert.equal(matchReply(waits, 'green'), null);
});

test('an exact channel reply resolves the wait and moves the run on', async () => {
  await askApproval('channel');
  const resolved = await tryResolveFromMessage('tg:1', 'main', 'approve');
  assert.ok(resolved);
  assert.equal(
    listOpenWaits('human').filter((w) => w.id === resolved.id).length,
    0,
  );
});

test('a Telegram button resolves the wait once', async () => {
  const waits = await askApproval('button');
  const id = waits[0].id;
  assert.equal(await resolveFromCallback('tg:1', `wf:${id}:a`), 'Approved');
  assert.equal(
    await resolveFromCallback('tg:1', `wf:${id}:a`),
    'Already answered.',
  );
  assert.equal(
    await resolveFromCallback('tg:1', 'wf:nope:a'),
    'That question is gone.',
  );
  assert.equal(await resolveFromCallback('tg:1', 'not-a-callback'), null);
});

test('open waits are described for the agent turn', async () => {
  await askApproval('described');
  const text = describeOpenWaits('tg:1', 'main');
  assert.ok(text);
  assert.match(text, /pending_workflow_questions/);
  assert.match(text, /workflow_respond/);
  assert.match(text, /Send the digest\?/);
});
