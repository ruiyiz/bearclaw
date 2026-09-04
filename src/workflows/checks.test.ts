import assert from 'node:assert/strict';
import { test } from 'node:test';

import { advise, inspect } from './checks.js';
import { parseDefinition } from './schema.js';

function def(partial: Record<string, unknown>) {
  return parseDefinition({
    name: 'Check',
    slug: 'check',
    owner: 'main',
    nodes: { go: { type: 'transform', expr: '1' } },
    edges: [],
    ...partial,
  });
}

const CRON = {
  id: 'schedule',
  type: 'cron',
  cron: '0 7 * * *',
  enabled: true,
};

test('a human step under skip is flagged as stalling the schedule', () => {
  const issues = advise(
    def({
      triggers: [CRON],
      policies: { concurrency: 'skip', alerts: { on_failure: 'owner' } },
      nodes: { ask: { type: 'human', kind: 'input', prompt: 'well?' } },
    }),
  );
  assert.deepEqual(
    issues.map((i) => i.check),
    ['human/blocking-schedule'],
  );
  assert.equal(issues[0].node, 'ask');

  // replace supersedes rather than drops, so it is not flagged.
  const replaced = advise(
    def({
      triggers: [CRON],
      policies: { concurrency: 'replace', alerts: { on_failure: 'owner' } },
      nodes: { ask: { type: 'human', kind: 'input', prompt: 'well?' } },
    }),
  );
  assert.deepEqual(replaced, []);
});

test('a silent human step is flagged unless its prompt names the wait', () => {
  const nag = (prompt: string) =>
    advise(
      def({
        policies: { concurrency: 'allow' },
        nodes: {
          ask: { type: 'human', kind: 'input', notify: false, prompt },
        },
      }),
    ).map((i) => i.check);

  assert.deepEqual(nag('Reply to this'), ['human/unaddressed']);
  assert.deepEqual(nag('Reply quoting {{wait.id}}'), []);
});

test('a scheduled workflow with no failure alert is flagged', () => {
  assert.deepEqual(
    advise(def({ triggers: [CRON] })).map((i) => i.check),
    ['alerts/no-on-failure'],
  );
  // No schedule, no one waiting on it: nothing to say.
  assert.deepEqual(advise(def({})), []);
});

test('a shell hole outside quotes is flagged, one inside them is not', () => {
  const checks = (cmd: string, inputs?: Record<string, unknown>) =>
    advise(
      def({
        ...(inputs ? { inputs: { type: 'object', properties: inputs } } : {}),
        nodes: { run: { type: 'shell', cmd } },
      }),
    ).map((i) => i.check);

  assert.deepEqual(checks('send --text {{trigger.payload.text}}'), [
    'shell/unquoted-hole',
  ]);
  assert.deepEqual(checks('send --text {{q trigger.payload.text}}'), []);
  // Already inside single quotes — a JSON blob of params, say.
  assert.deepEqual(checks('api --params \'{"id":"{{inputs.who}}"}\''), []);
  // A declared number cannot carry a space.
  assert.deepEqual(
    checks('send --chat-id {{inputs.chat_id}}', {
      chat_id: { type: 'integer' },
    }),
    [],
  );
  assert.deepEqual(
    checks('send --chat-id {{inputs.chat_id}}', {
      chat_id: { type: 'string' },
    }),
    ['shell/unquoted-hole'],
  );
  // join is unquoted on purpose — it turns a list into separate arguments, and
  // helpers do not nest, so there is no q-wrapped spelling of it.
  assert.deepEqual(checks("read {{join trigger.payload.ids ' '}}"), [
    'shell/joined-args',
  ]);
});

test('an agent node is only flagged when something reads it', () => {
  const read = def({
    nodes: {
      think: { type: 'agent', prompt: 'go' },
      use: { type: 'template', template: '{{nodes.think.output}}' },
    },
    edges: [{ from: 'think', to: 'use' }],
  });
  assert.deepEqual(
    advise(read).map((i) => i.check),
    ['agent/no-output-schema'],
  );

  const terminal = def({ nodes: { think: { type: 'agent', prompt: 'go' } } });
  assert.deepEqual(advise(terminal), []);
});

test('inspect checks an unsaved draft and reports instead of throwing', () => {
  // A dangling edge is a graph error; the missing failure alert is advice.
  // Both come back from one call, and neither throws.
  const issues = inspect({
    name: 'Draft',
    slug: 'draft',
    owner: 'main',
    triggers: [CRON],
    nodes: { a: { type: 'transform', expr: '1' } },
    edges: [{ from: 'a', to: 'nope' }],
  });
  assert.ok(issues.some((i) => i.level === 'error' && i.check === 'graph'));
  assert.ok(
    issues.some(
      (i) => i.level === 'warn' && i.check === 'alerts/no-on-failure',
    ),
  );

  // A malformed shape stops at the schema layer.
  const bad = inspect({ name: 'x' });
  assert.ok(bad.length);
  assert.ok(bad.every((i) => i.check === 'schema' && i.level === 'error'));

  // The loader still refuses what inspect merely reports.
  assert.throws(
    () => parseDefinition({ name: 'x' }),
    /invalid workflow definition/,
  );
});
