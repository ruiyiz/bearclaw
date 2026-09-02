import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluate,
  expandWildcards,
  parseDuration,
  render,
  renderDeep,
  shellQuote,
  type EvalScope,
} from './expr.js';

const scope: EvalScope = {
  run: {
    id: 'run_1',
    slug: 'demo',
    started_at: '2026-09-02T00:00:00.000Z',
    key: 'run_1',
  },
  trigger: { id: 'nightly', type: 'cron', payload: { source: 'test' } },
  inputs: { limit: 15, name: 'Feeds' },
  nodes: {
    unread: {
      output: [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' },
      ],
      status: 'succeeded',
    },
    empty: { output: [], status: 'succeeded' },
  },
  env: { OWNER_EMAIL: 'owner@example.com' },
  error: null,
};

test('evaluate reads context paths', () => {
  assert.equal(evaluate('inputs.limit', scope), 15);
  assert.equal(evaluate('nodes.unread.output.length > 0', scope), true);
  assert.equal(evaluate('nodes.empty.output.length > 0', scope), false);
  assert.equal(evaluate('trigger.payload.source', scope), 'test');
});

test('evaluate has no ambient Date or Math.random', () => {
  assert.throws(() => evaluate('Date.now()', scope), /expression failed/);
  assert.throws(() => evaluate('Math.random()', scope), /expression failed/);
  assert.equal(evaluate('Math.max(1, 2)', scope), 2);
});

test('expandWildcards plucks a field off every element', () => {
  assert.equal(
    expandWildcards('nodes.unread.output.*.id'),
    '(nodes.unread.output).map((__w) => __w.id)',
  );
  assert.deepEqual(evaluate('nodes.unread.output.*.id', scope), [1, 2]);
});

test('render interpolates and applies helpers', () => {
  assert.equal(render('limit={{inputs.limit}}', scope), 'limit=15');
  assert.equal(render("{{join nodes.unread.output.*.id ' '}}", scope), '1 2');
  assert.equal(render('{{json nodes.unread.output.*.id}}', scope), '[1,2]');
  assert.equal(render("{{default inputs.missing 'none'}}", scope), 'none');
  assert.equal(render('{{env.OWNER_EMAIL}}', scope), 'owner@example.com');
});

test('q quotes for the shell', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(render('--body {{q inputs.name}}', scope), `--body 'Feeds'`);
});

test('renderDeep walks objects and arrays', () => {
  assert.deepEqual(
    renderDeep({ a: ['{{inputs.limit}}'], b: { c: '{{inputs.name}}' } }, scope),
    { a: ['15'], b: { c: 'Feeds' } },
  );
});

test('parseDuration covers the units workflows use', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('2m'), 120_000);
  assert.equal(parseDuration('3d'), 259_200_000);
  assert.throws(() => parseDuration('soon'), /invalid duration/);
});
