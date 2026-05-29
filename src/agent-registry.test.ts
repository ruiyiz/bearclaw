import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isNestedRegistry,
  jidForChannelKey,
  migrateFlatToNested,
  resolveRegistry,
} from './agent-registry.js';
import type { AgentRegistry, RegisteredAgent } from './types.js';

const FLAT: Record<string, RegisteredAgent> = {
  '18046155370@s.whatsapp.net': {
    name: 'Luce',
    folder: 'main',
    trigger: '@CoCo',
    added_at: '2026-02-06T03:38:00.000Z',
  },
  'tg:1719584668': {
    name: 'Luce',
    folder: 'main',
    trigger: '',
    added_at: '2026-02-15T20:00:00.000Z',
    requiresTrigger: false,
    primary: true,
  },
  'imsg:17': {
    name: 'CoCo',
    folder: 'coco',
    trigger: '@CoCo',
    added_at: '2026-03-07T00:00:00.000Z',
  },
  '120363406031716049@g.us': {
    name: 'CoCo',
    folder: 'coco',
    trigger: '',
    added_at: '2026-02-06T05:02:03.993Z',
    email: { address: 'owner+coco@gmail.com', interval: '30m' },
  },
  'web:coco': {
    name: 'CoCo',
    folder: 'coco',
    trigger: '',
    added_at: '2026-05-26T01:42:57.550Z',
  },
};

test('migrateFlatToNested groups by folder and hoists agent-level fields', () => {
  const nested = migrateFlatToNested(FLAT);
  assert.deepEqual(Object.keys(nested).sort(), ['coco', 'main']);
  assert.equal(nested.main.name, 'Luce');
  assert.equal(nested.coco.name, 'CoCo');
});

test('migrateFlatToNested moves channel-level fields under channels[jid]', () => {
  const nested = migrateFlatToNested(FLAT);
  assert.deepEqual(nested.main.channels['18046155370@s.whatsapp.net'], {
    added_at: '2026-02-06T03:38:00.000Z',
    trigger: '@CoCo',
  });
  assert.deepEqual(nested.main.channels['tg:1719584668'], {
    added_at: '2026-02-15T20:00:00.000Z',
    trigger: '',
    requiresTrigger: false,
    primary: true,
  });
});

test('migrateFlatToNested rewrites web:<folder> to bare web key (no trigger)', () => {
  const nested = migrateFlatToNested(FLAT);
  assert.ok('web' in nested.coco.channels);
  assert.ok(!('web:coco' in nested.coco.channels));
  assert.equal(nested.coco.channels.web.trigger, undefined);
});

test('migrateFlatToNested converts legacy email field to channels.email', () => {
  const nested = migrateFlatToNested(FLAT);
  assert.deepEqual(nested.coco.channels.email, {
    added_at: '2026-02-06T05:02:03.993Z',
    address: 'owner+coco@gmail.com',
    interval: '30m',
  });
});

test('resolveRegistry round-trips the migrated registry back to flat jids', () => {
  const nested = migrateFlatToNested(FLAT);
  const flat = resolveRegistry(nested);
  // web:<folder> jid reconstructed from the bare key.
  assert.ok('web:coco' in flat);
  // Real routing jids preserved.
  assert.ok('imsg:17' in flat);
  assert.ok('tg:1719584668' in flat);
  // email routes as email:<folder>, never the bare "email" key.
  assert.ok(!('email' in flat));
  assert.ok('email:coco' in flat);
  assert.equal(flat['imsg:17'].folder, 'coco');
  assert.equal(flat['imsg:17'].name, 'CoCo');
  assert.equal(flat['tg:1719584668'].trigger, '');
  assert.equal(flat['tg:1719584668'].primary, true);
});

test('resolveRegistry emits a dedicated email:<folder> entry (no trigger, no off-hours)', () => {
  const nested = migrateFlatToNested(FLAT);
  const flat = resolveRegistry(nested);
  assert.ok('email:coco' in flat);
  assert.deepEqual(flat['email:coco'].email, {
    address: 'owner+coco@gmail.com',
    interval: '30m',
  });
  assert.equal(flat['email:coco'].trigger, '');
  assert.equal(flat['email:coco'].activeHours, undefined);
  // email config is NOT copied onto the folder's other channels.
  assert.equal(flat['imsg:17'].email, undefined);
  assert.equal(flat['web:coco'].email, undefined);
});

test('resolveRegistry defaults missing trigger to empty string', () => {
  const reg: AgentRegistry = {
    coco: { name: 'CoCo', channels: { web: { added_at: 'x' } } },
  };
  assert.equal(resolveRegistry(reg)['web:coco'].trigger, '');
});

test('isNestedRegistry distinguishes the two shapes', () => {
  assert.equal(isNestedRegistry({}), true);
  assert.equal(isNestedRegistry(migrateFlatToNested(FLAT)), true);
  assert.equal(isNestedRegistry(FLAT), false);
  assert.equal(isNestedRegistry([]), false);
  assert.equal(isNestedRegistry(null), false);
});

test('jidForChannelKey reconstructs web jids, passes others through', () => {
  assert.equal(jidForChannelKey('coco', 'web'), 'web:coco');
  assert.equal(jidForChannelKey('coco', 'imsg:17'), 'imsg:17');
});
