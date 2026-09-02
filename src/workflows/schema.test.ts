import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  WorkflowValidationError,
  checkGraph,
  parseDefinition,
  portsOf,
  topoOrder,
} from './schema.js';

const MINIMAL = {
  name: 'Demo',
  slug: 'demo',
  owner: 'main',
  nodes: {
    a: { type: 'transform', expr: '1' },
    b: { type: 'transform', expr: 'nodes.a.output + 1' },
  },
  edges: [{ from: 'a', to: 'b' }],
};

test('parseDefinition fills defaults', () => {
  const def = parseDefinition(MINIMAL);
  assert.equal(def.edges[0].port, 'success');
  assert.equal(def.policies.concurrency, 'allow');
  assert.deepEqual(def.triggers, []);
});

test('parseDefinition rejects an unknown node type', () => {
  assert.throws(
    () =>
      parseDefinition({
        ...MINIMAL,
        nodes: { a: { type: 'nope' } },
        edges: [],
      }),
    WorkflowValidationError,
  );
});

test('checkGraph catches dangling edges, bad ports and cycles', () => {
  const dangling = parseDefinition({
    ...MINIMAL,
    edges: [],
  });
  assert.deepEqual(
    checkGraph({
      ...dangling,
      edges: [{ from: 'a', to: 'ghost', port: 'success' }],
    }),
    ['edge to unknown node "ghost"'],
  );

  const issues = checkGraph({
    ...dangling,
    edges: [
      { from: 'a', to: 'b', port: 'true' },
      { from: 'b', to: 'a', port: 'success' },
    ],
  });
  assert.ok(issues.some((i) => i.includes('has no port "true"')));
  assert.ok(issues.some((i) => i.startsWith('cycle:')));
});

test('portsOf follows the node kind', () => {
  assert.deepEqual(portsOf({ type: 'condition', expr: 'true' } as never), [
    'true',
    'false',
    'error',
  ]);
  assert.deepEqual(
    portsOf({ type: 'switch', expr: 'x', cases: ['red', 'blue'] } as never),
    ['red', 'blue', 'default', 'error'],
  );
  assert.deepEqual(
    portsOf({ type: 'human', kind: 'approve', prompt: 'ok?' } as never),
    ['approved', 'rejected', 'timeout', 'error'],
  );
});

test('a branching node needs its own ports wired', () => {
  const def = {
    name: 'Branch',
    slug: 'branch',
    owner: 'main',
    nodes: {
      check: { type: 'condition', expr: 'true' },
      yes: { type: 'transform', expr: '1' },
      no: { type: 'transform', expr: '0' },
    },
    edges: [
      { from: 'check', to: 'yes', port: 'true' },
      { from: 'check', to: 'no', port: 'false' },
    ],
  };
  const parsed = parseDefinition(def);
  assert.deepEqual(topoOrder(parsed), ['check', 'yes', 'no']);
});

test('template and delay nodes need a source', () => {
  assert.throws(
    () =>
      parseDefinition({
        ...MINIMAL,
        nodes: { a: { type: 'template' } },
        edges: [],
      }),
    /invalid workflow graph/,
  );
});
