import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { initDatabase } from '../db.js';
import {
  getRun,
  insertRun,
  insertStep,
  listOpenWaits,
  listRunEvents,
  listSteps,
  newId,
  type RunRow,
  type StepRow,
} from './db.js';
import {
  advance,
  applyInputs,
  cancelRun,
  forkRun,
  recover,
  resolveWait,
  setEngineDeps,
  startRun,
  tick,
} from './engine.js';
import { parseDefinition, type WorkflowDefinition } from './schema.js';
import { makeFakeDeps, type FakeDeps } from './testing.js';

initDatabase(':memory:');

let fake: FakeDeps;

beforeEach(() => {
  fake = makeFakeDeps();
  setEngineDeps(fake);
});

function def(partial: Record<string, unknown>): WorkflowDefinition {
  return parseDefinition({
    name: 'Test',
    slug: 'test',
    owner: 'main',
    edges: [],
    ...partial,
  });
}

function stepsByNode(runId: string): Map<string, StepRow> {
  const out = new Map<string, StepRow>();
  for (const s of listSteps(runId)) out.set(s.node_id, s);
  return out;
}

function outputOf(runId: string, nodeId: string): unknown {
  return stepsByNode(runId).get(nodeId)?.output ?? null;
}

function requireRun(id: string | null): RunRow {
  assert.ok(id);
  const run = getRun(id);
  assert.ok(run);
  return run;
}

test('a linear run executes in order and threads outputs', async () => {
  fake.shellImpl = () => ({ code: 0, stdout: '{"count": 3}', stderr: '' });
  const definition = def({
    slug: 'linear',
    nodes: {
      count: { type: 'shell', cmd: 'feeds count', parse: 'json' },
      double: { type: 'transform', expr: 'nodes.count.output.count * 2' },
      note: { type: 'template', template: 'saw {{nodes.double.output}}' },
    },
    edges: [
      { from: 'count', to: 'double' },
      { from: 'double', to: 'note' },
    ],
  });

  const { runId } = await startRun({ slug: 'linear', definition });
  const run = requireRun(runId);
  assert.equal(run.status, 'succeeded');
  assert.equal(outputOf(run.id, 'double'), 6);
  assert.equal(outputOf(run.id, 'note'), 'saw 6');
  assert.equal(fake.shellCalls[0].env?.BEARCLAW_STEP_KEY, `${run.id}:count:1`);
});

test('inputs get defaults and are required when declared', () => {
  const definition = def({
    inputs: {
      type: 'object',
      required: ['text'],
      properties: { limit: { type: 'integer', default: 15 }, text: {} },
    },
    nodes: { noop: { type: 'transform', expr: '1' } },
  });
  assert.deepEqual(applyInputs(definition, { text: 'hi' }), {
    text: 'hi',
    limit: 15,
  });
  assert.throws(() => applyInputs(definition, {}), /text is required/);
  assert.throws(
    () => applyInputs(definition, { text: 'hi', limit: 'many' }),
    /limit should be integer/,
  );
});

test('a condition takes one branch and the other never runs', async () => {
  const definition = def({
    slug: 'branch',
    nodes: {
      unread: { type: 'transform', expr: '[1, 2]' },
      any: { type: 'condition', expr: 'nodes.unread.output.length > 0' },
      digest: { type: 'transform', expr: '"digest"' },
      caught_up: { type: 'transform', expr: '"caught up"' },
      persist: { type: 'transform', expr: '"persisted"' },
    },
    edges: [
      { from: 'unread', to: 'any' },
      { from: 'any', port: 'true', to: 'digest' },
      { from: 'any', port: 'false', to: 'caught_up' },
      { from: 'digest', to: 'persist' },
      { from: 'caught_up', to: 'persist' },
    ],
  });

  const { runId } = await startRun({ slug: 'branch', definition });
  const run = requireRun(runId);
  assert.equal(run.status, 'succeeded');
  const steps = stepsByNode(run.id);
  assert.equal(steps.get('digest')?.status, 'succeeded');
  // The untaken branch never runs, and never blocks the join below it.
  assert.equal(steps.has('caught_up'), false);
  assert.equal(outputOf(run.id, 'persist'), 'persisted');
});

test('retry exhausts before the error port, which keeps the run alive', async () => {
  let calls = 0;
  fake.shellImpl = () => {
    calls += 1;
    return calls < 3
      ? { code: 1, stdout: '', stderr: 'boom' }
      : { code: 0, stdout: 'sent', stderr: '' };
  };
  const definition = def({
    slug: 'retry',
    nodes: {
      send: {
        type: 'shell',
        cmd: 'gws gmail +send',
        retry: { max: 2, backoff: '1ms' },
      },
    },
  });

  const { runId } = await startRun({ slug: 'retry', definition });
  const run = requireRun(runId);
  assert.equal(run.status, 'succeeded');
  assert.equal(calls, 3);
  assert.equal(listSteps(run.id).length, 3);
});

test('a failure routes down the error port when one is wired', async () => {
  fake.shellImpl = () => ({ code: 1, stdout: '', stderr: 'nope' });
  const definition = def({
    slug: 'errport',
    nodes: {
      send: { type: 'shell', cmd: 'false' },
      persist: { type: 'transform', expr: '"persisted"' },
      failed: {
        type: 'send',
        text: 'failed at {{error.node}}: {{error.message}}',
      },
    },
    edges: [
      { from: 'send', to: 'persist' },
      { from: 'send', port: 'error', to: 'failed' },
    ],
  });

  const { runId } = await startRun({ slug: 'errport', definition });
  const run = requireRun(runId);
  assert.equal(run.status, 'succeeded');
  assert.equal(stepsByNode(run.id).has('persist'), false);
  assert.match(fake.sends[0].text, /^failed at send: exit 1/);
});

test('an unwired error port fails the run', async () => {
  fake.shellImpl = () => ({ code: 2, stdout: '', stderr: 'nope' });
  const definition = def({
    slug: 'failfast',
    nodes: { send: { type: 'shell', cmd: 'false' } },
  });
  const { runId } = await startRun({ slug: 'failfast', definition });
  const run = requireRun(runId);
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /node "send" failed/);
});

test('a human node parks the run until someone answers', async () => {
  const definition = def({
    slug: 'approval',
    nodes: {
      draft: { type: 'transform', expr: '"draft"' },
      ask: {
        type: 'human',
        kind: 'approve',
        prompt: 'Send it?',
        to: ['imsg:17'],
      },
      send: { type: 'send', text: 'sent' },
      drop: { type: 'transform', expr: '"dropped"' },
    },
    edges: [
      { from: 'draft', to: 'ask' },
      { from: 'ask', port: 'approved', to: 'send' },
      { from: 'ask', port: 'rejected', to: 'drop' },
    ],
  });

  const { runId } = await startRun({ slug: 'approval', definition });
  const run = requireRun(runId);
  assert.equal(run.status, 'waiting');

  const waits = listOpenWaits('human');
  assert.equal(waits.length, 1);
  assert.equal(waits[0].prompt, 'Send it?');
  assert.deepEqual(waits[0].targets, ['imsg:17']);
  // Every wait expires: three days by default.
  assert.equal(waits[0].resume_at, '2026-09-05T02:00:00.000Z');

  await resolveWait(waits[0].id, { approved: true }, 'imsg:17', 'telegram');
  const after = requireRun(runId);
  assert.equal(after.status, 'succeeded');
  assert.equal(stepsByNode(after.id).get('ask')?.port, 'approved');
  assert.equal(stepsByNode(after.id).has('drop'), false);
  assert.equal(fake.sends.length, 1);
});

test('a human wait that expires follows on_timeout', async () => {
  const definition = def({
    slug: 'expiring',
    nodes: {
      ask: {
        type: 'human',
        kind: 'approve',
        prompt: 'ok?',
        expires: '1h',
        on_timeout: 'reject',
      },
      send: { type: 'send', text: 'sent' },
      drop: { type: 'transform', expr: '"dropped"' },
    },
    edges: [
      { from: 'ask', port: 'approved', to: 'send' },
      { from: 'ask', port: 'rejected', to: 'drop' },
    ],
  });

  const { runId } = await startRun({ slug: 'expiring', definition });
  assert.equal(requireRun(runId).status, 'waiting');

  fake.clock = new Date('2026-09-02T04:00:00.000Z');
  await tick();

  const run = requireRun(runId);
  assert.equal(run.status, 'succeeded');
  assert.equal(outputOf(run.id, 'drop'), 'dropped');
  assert.equal(fake.sends.length, 0);
});

test('a delay is a timer row that the tick wakes', async () => {
  const definition = def({
    slug: 'delayed',
    nodes: {
      wait: { type: 'delay', duration: '1h' },
      after: { type: 'transform', expr: '"after"' },
    },
    edges: [{ from: 'wait', to: 'after' }],
  });

  const { runId } = await startRun({ slug: 'delayed', definition });
  assert.equal(requireRun(runId).status, 'waiting');
  await tick();
  assert.equal(requireRun(runId).status, 'waiting');

  fake.clock = new Date('2026-09-02T03:30:00.000Z');
  await tick();
  const run = requireRun(runId);
  assert.equal(run.status, 'succeeded');
  assert.equal(outputOf(run.id, 'after'), 'after');
});

test('wait_event matches a signal that landed before the node was reached', async () => {
  const definition = def({
    slug: 'signal',
    nodes: {
      kick: {
        type: 'emit',
        event: 'newsletter_queue_empty',
        payload: { queue: 'main' },
      },
      pause: { type: 'delay', duration: '1h' },
      listen: {
        type: 'wait_event',
        event: 'newsletter_queue_empty',
        filter: { queue: 'main' },
        timeout: '2h',
      },
      done: { type: 'transform', expr: '"done"' },
    },
    edges: [
      { from: 'kick', to: 'pause' },
      { from: 'pause', to: 'listen' },
      { from: 'listen', port: 'received', to: 'done' },
    ],
  });

  const { runId } = await startRun({ slug: 'signal', definition });
  fake.clock = new Date('2026-09-02T03:30:00.000Z');
  await tick();

  const run = requireRun(runId);
  assert.equal(run.status, 'succeeded');
  assert.equal(stepsByNode(run.id).get('listen')?.port, 'received');
  assert.equal(outputOf(run.id, 'done'), 'done');
});

test('wait_event times out when nothing arrives', async () => {
  const definition = def({
    slug: 'silence',
    nodes: {
      listen: { type: 'wait_event', event: 'never', timeout: '1h' },
      gave_up: { type: 'transform', expr: '"gave up"' },
    },
    edges: [{ from: 'listen', port: 'timeout', to: 'gave_up' }],
  });

  const { runId } = await startRun({ slug: 'silence', definition });
  assert.equal(requireRun(runId).status, 'waiting');
  fake.clock = new Date('2026-09-02T04:00:00.000Z');
  await tick();
  assert.equal(requireRun(runId).status, 'succeeded');
  assert.equal(outputOf(runId!, 'gave_up'), 'gave up');
});

test('concurrency skip drops a second run while one is waiting', async () => {
  const definition = def({
    slug: 'once',
    policies: { concurrency: 'skip' },
    nodes: { ask: { type: 'human', kind: 'input', prompt: 'reply' } },
  });

  const first = await startRun({ slug: 'once', definition });
  assert.equal(first.status, 'started');
  const second = await startRun({ slug: 'once', definition });
  assert.deepEqual(second, { runId: null, status: 'skipped' });
});

test('concurrency queue starts the next run when the first finishes', async () => {
  const definition = def({
    slug: 'queued',
    policies: { concurrency: 'queue' },
    nodes: { ask: { type: 'human', kind: 'input', prompt: 'reply' } },
  });

  const first = await startRun({ slug: 'queued', definition });
  const second = await startRun({ slug: 'queued', definition });
  assert.equal(second.status, 'queued');
  assert.equal(requireRun(second.runId).status, 'queued');

  const wait = listOpenWaits('human').find((w) => w.run_id === first.runId)!;
  await resolveWait(wait.id, { text: 'ok' }, null, 'web');
  assert.equal(requireRun(first.runId).status, 'succeeded');
  assert.equal(requireRun(second.runId).status, 'waiting');
});

test('an agent node hands typed output to the next node', async () => {
  fake.agentImpl = () => ({
    status: 'success',
    text: null,
    structured: [{ id: 1, summary: 'first' }],
    sessionId: 'sess_1',
  });
  const definition = def({
    slug: 'typed',
    nodes: {
      summarize: {
        type: 'agent',
        prompt: 'Summarize {{inputs.name}}',
        session: 'run',
        output_schema: { type: 'array' },
      },
      first: { type: 'transform', expr: 'nodes.summarize.output[0].summary' },
    },
    edges: [{ from: 'summarize', to: 'first' }],
  });

  const { runId } = await startRun({
    slug: 'typed',
    definition,
    inputs: { name: 'feeds' },
  });
  const run = requireRun(runId);
  assert.equal(run.status, 'succeeded');
  assert.equal(outputOf(run.id, 'first'), 'first');
  assert.match(fake.agentCalls[0].prompt, /Summarize feeds/);
  assert.match(fake.agentCalls[0].prompt, /\[WORKFLOW Test \(typed\)/);
  assert.equal(
    stepsByNode(run.id).get('summarize')?.agent_session_id,
    'sess_1',
  );
  assert.equal(
    (run.context.__sessions as Record<string, string>)['agent:main'],
    'sess_1',
  );
});

test('a schema node that returns prose is a failure, not a success', async () => {
  fake.agentImpl = () => ({ status: 'success', text: 'here you go!' });
  const definition = def({
    slug: 'unstructured',
    nodes: {
      summarize: {
        type: 'agent',
        prompt: 'summarize',
        output_schema: { type: 'array' },
      },
    },
  });
  const { runId } = await startRun({ slug: 'unstructured', definition });
  const run = requireRun(runId);
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /no structured output/);
});

test('a run snapshots its definition, so later edits do not change it', async () => {
  const definition = def({
    slug: 'snap',
    nodes: { ask: { type: 'human', kind: 'input', prompt: 'v1' } },
  });
  const { runId } = await startRun({ slug: 'snap', definition });
  const run = requireRun(runId);
  assert.equal((run.definition.nodes.ask as { prompt: string }).prompt, 'v1');
});

test('recover re-dispatches steps left running by a restart', async () => {
  const definition = def({
    slug: 'crashed',
    nodes: { work: { type: 'transform', expr: '"finished"' } },
  });
  const id = newId('run');
  insertRun({
    id,
    slug: 'crashed',
    definition,
    definition_hash: 'x',
    inputs: {},
    status: 'running',
  });
  insertStep({ run_id: id, node_id: 'work', attempt: 1, status: 'running' });

  await recover();

  const run = requireRun(id);
  assert.equal(run.status, 'succeeded');
  const steps = listSteps(id);
  assert.equal(steps[0].status, 'interrupted');
  assert.equal(steps[1].status, 'succeeded');
  assert.equal(steps[1].attempt, 2);
});

test('cancel stops the run and closes its waits', async () => {
  const definition = def({
    slug: 'cancelme',
    nodes: { ask: { type: 'human', kind: 'input', prompt: 'reply' } },
  });
  const { runId } = await startRun({ slug: 'cancelme', definition });
  await cancelRun(runId!, 'user cancelled');
  assert.equal(requireRun(runId).status, 'cancelled');
  assert.equal(
    listOpenWaits('human').filter((w) => w.run_id === runId).length,
    0,
  );
  await advance(runId!);
  assert.equal(requireRun(runId).status, 'cancelled');
});

test('the run timeline records every step transition', async () => {
  const definition = def({
    slug: 'timeline',
    nodes: { work: { type: 'transform', expr: '1' } },
  });
  const { runId } = await startRun({ slug: 'timeline', definition });
  const kinds = listRunEvents(runId!).map((e) => e.kind);
  assert.deepEqual(kinds, [
    'run.started',
    'step.started',
    'step.succeeded',
    'run.succeeded',
  ]);
});

test('retry from a node forks: ancestors are copied, the rest re-runs', async () => {
  let calls = 0;
  fake.shellImpl = () => {
    calls += 1;
    return calls === 1
      ? { code: 1, stdout: '', stderr: 'transient' }
      : { code: 0, stdout: 'sent', stderr: '' };
  };
  const definition = def({
    slug: 'forkable',
    nodes: {
      prepare: { type: 'transform', expr: '"prepared"' },
      send: { type: 'shell', cmd: 'gws gmail +send' },
      after: { type: 'transform', expr: '"after"' },
    },
    edges: [
      { from: 'prepare', to: 'send' },
      { from: 'send', to: 'after' },
    ],
  });

  const { runId } = await startRun({ slug: 'forkable', definition });
  assert.equal(requireRun(runId).status, 'failed');

  const forkId = await forkRun(runId!, 'send');
  const fork = requireRun(forkId);
  assert.equal(fork.status, 'succeeded');
  assert.equal(fork.parent_run_id, runId);
  assert.equal(fork.forked_at_node, 'send');

  const steps = stepsByNode(forkId);
  // The ancestor is copied, not re-executed.
  assert.equal(steps.get('prepare')?.output, 'prepared');
  assert.equal(calls, 2);
  assert.equal(steps.get('after')?.output, 'after');

  // The parent keeps its own history.
  assert.equal(requireRun(runId).status, 'failed');
});

test('a fork can override the input of the node it restarts from', async () => {
  const definition = def({
    slug: 'override',
    nodes: {
      fetch: { type: 'transform', expr: '"original"' },
      use: { type: 'transform', expr: 'nodes.fetch.output + "!"' },
    },
    edges: [{ from: 'fetch', to: 'use' }],
  });
  const { runId } = await startRun({ slug: 'override', definition });
  assert.equal(outputOf(runId!, 'use'), 'original!');

  const forkId = await forkRun(runId!, 'use', {
    node: 'fetch',
    output: 'patched',
  });
  assert.equal(outputOf(forkId, 'use'), 'patched!');
});
