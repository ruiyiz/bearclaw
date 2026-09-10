import assert from 'node:assert/strict';
import test from 'node:test';

import { migrateModelOverrides } from './backend.js';

test('migrates legacy overrides to portable tiers', () => {
  const models = { main: 'opus', research: 'pi:openai-codex/gpt-5.6-terra' };
  const migrated = migrateModelOverrides(
    models,
    'pi',
    'pi:openai-codex/gpt-5.6-terra',
  );
  assert.deepEqual(migrated, ['main', 'research']);
  assert.deepEqual(models, { main: 'advanced', research: 'default' });
});

test('leaves unknown provider model ids untouched', () => {
  const models = { main: 'opus' };
  assert.deepEqual(
    migrateModelOverrides(
      models,
      'claude-sdk',
      'pi:openai-codex/gpt-5.6-terra',
    ),
    ['main'],
  );
  assert.equal(models.main, 'advanced');
});
