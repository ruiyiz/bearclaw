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
  // Edgeless, so `b` must not read `a` — that is its own error now.
  const dangling = parseDefinition({
    ...MINIMAL,
    nodes: {
      a: { type: 'transform', expr: '1' },
      b: { type: 'transform', expr: '2' },
    },
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

test('an agent output_schema must be an object', () => {
  const base = {
    name: 'Typed',
    slug: 'typed',
    owner: 'main',
    edges: [],
  };
  try {
    parseDefinition({
      ...base,
      nodes: {
        sum: {
          type: 'agent',
          prompt: 'go',
          output_schema: { type: 'array', items: { type: 'string' } },
        },
      },
    });
    assert.fail('expected a validation error');
  } catch (err) {
    assert.ok(err instanceof WorkflowValidationError);
    assert.ok(
      err.issues.some((i) => i.includes('output_schema of type "object"')),
    );
  }
  const ok = parseDefinition({
    ...base,
    nodes: {
      sum: {
        type: 'agent',
        prompt: 'go',
        output_schema: {
          type: 'object',
          properties: { items: { type: 'array' } },
          required: ['items'],
        },
      },
    },
  });
  assert.equal(ok.slug, 'typed');
});

test('map rejects an inner node that would park per item', () => {
  const base = { name: 'M', slug: 'm', owner: 'main', edges: [] };
  const issuesFor = (inner: Record<string, unknown>) => {
    try {
      parseDefinition({
        ...base,
        nodes: { each: { type: 'map', over: 'inputs.items', node: inner } },
      });
      return [];
    } catch (err) {
      return (err as WorkflowValidationError).issues;
    }
  };
  assert.ok(
    issuesFor({ type: 'human', kind: 'input', prompt: 'x' }).some((i) =>
      i.includes('would park per item'),
    ),
  );
  assert.ok(
    issuesFor({ type: 'nonsense' }).some((i) =>
      i.includes('invalid inner node'),
    ),
  );
  assert.deepEqual(issuesFor({ type: 'shell', cmd: 'echo {{item}}' }), []);
});

test('a node cannot read one that is not upstream of it', () => {
  const base = { name: 'Wiring', slug: 'wiring', owner: 'main' };

  // The exact mistake: a node added to the middle of a chain but never wired,
  // so it becomes a second entry and runs before what it reads.
  const issues = (() => {
    try {
      parseDefinition({
        ...base,
        nodes: {
          send: { type: 'shell', cmd: 'send-it', parse: 'json' },
          batch: {
            type: 'transform',
            expr: '({ id: nodes.send.output.threadId })',
          },
          persist: {
            type: 'shell',
            cmd: 'cat > out',
            stdin: '{{nodes.batch.output}}',
          },
        },
        edges: [{ from: 'send', to: 'persist' }],
      });
      return [];
    } catch (err) {
      return (err as WorkflowValidationError).issues;
    }
  })();
  assert.ok(issues.some((i) => i.includes('"batch" reads nodes.send')));
  assert.ok(issues.some((i) => i.includes('not upstream')));

  // Wired through, the same three nodes are fine.
  const ok = parseDefinition({
    ...base,
    nodes: {
      send: { type: 'shell', cmd: 'send-it', parse: 'json' },
      batch: {
        type: 'transform',
        expr: '({ id: nodes.send.output.threadId })',
      },
      persist: {
        type: 'shell',
        cmd: 'cat > out',
        stdin: '{{nodes.batch.output}}',
      },
    },
    edges: [
      { from: 'send', to: 'batch' },
      { from: 'batch', to: 'persist' },
    ],
  });
  assert.equal(Object.keys(ok.nodes).length, 3);
});

test('a join may read either branch above it', () => {
  const def = parseDefinition({
    name: 'Join',
    slug: 'join',
    owner: 'main',
    nodes: {
      any: { type: 'condition', expr: 'true' },
      left: { type: 'transform', expr: '"l"' },
      right: { type: 'transform', expr: '"r"' },
      persist: {
        type: 'shell',
        cmd: 'cat > out',
        stdin: '{{ nodes.left ? nodes.left.output : nodes.right.output }}',
      },
    },
    edges: [
      { from: 'any', port: 'true', to: 'left' },
      { from: 'any', port: 'false', to: 'right' },
      { from: 'left', to: 'persist' },
      { from: 'right', to: 'persist' },
    ],
  });
  assert.equal(def.slug, 'join');
});

test('reading a node that does not exist at all is caught', () => {
  try {
    parseDefinition({
      name: 'Ghost',
      slug: 'ghost',
      owner: 'main',
      nodes: { a: { type: 'transform', expr: 'nodes.nope.output' } },
      edges: [],
    });
    assert.fail('expected a validation error');
  } catch (err) {
    assert.ok(
      (err as WorkflowValidationError).issues.some((i) =>
        i.includes('does not exist'),
      ),
    );
  }
});

test('tags are lower-cased and de-duplicated', () => {
  const def = parseDefinition({
    name: 'Tagged',
    slug: 'tagged',
    owner: 'main',
    tags: ['Email', ' email ', 'Digest'],
    nodes: { a: { type: 'shell', cmd: 'true' } },
    edges: [],
  });
  assert.deepEqual(def.tags, ['email', 'digest']);
});

test('a workflow with no tags gets an empty list', () => {
  const def = parseDefinition({
    name: 'Bare',
    slug: 'bare',
    owner: 'main',
    nodes: { a: { type: 'shell', cmd: 'true' } },
    edges: [],
  });
  assert.deepEqual(def.tags, []);
});
