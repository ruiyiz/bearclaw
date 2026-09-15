import assert from 'node:assert/strict';
import test from 'node:test';

await import('./engine.js');
const { defaultDeps } = await import('./deps.js');

test('shell timeout kills the whole pipeline', async () => {
  const result = await defaultDeps.runShell({
    cmd: 'sleep 5 | cat',
    timeoutMs: 20,
    signal: new AbortController().signal,
  });

  assert.equal(result.timedOut, true);
});
