import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveModelReference,
  resolveModelTier,
  tierForModel,
} from './model-tiers.js';

test('maps portable tiers to the active provider', () => {
  assert.equal(
    resolveModelTier('default', 'pi'),
    'pi:openai-codex/gpt-5.6-terra',
  );
  assert.equal(resolveModelTier('advanced', 'claude-sdk'), 'opus');
});

test('migrates known legacy model aliases to portable tiers', () => {
  assert.equal(tierForModel('sonnet'), 'default');
  assert.equal(tierForModel('pi:openai-codex/gpt-5.6-sol'), 'advanced');
  assert.equal(tierForModel('fable'), 'frontier');
});

test('keeps explicit unknown model ids as an escape hatch', () => {
  assert.equal(
    resolveModelReference('pi:another-provider/custom-model', 'pi'),
    'pi:another-provider/custom-model',
  );
});
