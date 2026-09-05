import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import type { PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

import { createAgent } from '../store/agents.js';
import { agentVarDir, cacheDir } from '../store/paths.js';
import { withTempHome } from '../store/testing.js';
import { createCacheGuardHook, isUnderCacheDir } from './hooks.js';

const home = withTempHome('bearclaw-hooks-');
after(() => home.dispose());

createAgent('coco', 'Coco');
const cwd = agentVarDir('coco');
const hook = createCacheGuardHook();

function preToolUse(toolName: string, toolInput: unknown): PreToolUseHookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'tu_1',
    session_id: 's1',
    transcript_path: '/dev/null',
    cwd,
  };
}

async function decide(toolName: string, filePath?: string) {
  const out = await hook(
    preToolUse(toolName, filePath === undefined ? {} : { file_path: filePath }),
    'tu_1',
    { signal: new AbortController().signal },
  );
  return (out as { hookSpecificOutput?: { permissionDecision?: string } })
    .hookSpecificOutput?.permissionDecision;
}

test('a path reached through the agent cwd symlink is recognised as the cache', () => {
  assert.ok(isUnderCacheDir(path.join(cwd, 'context', 'shared', 'USER.md')));
  assert.ok(isUnderCacheDir('context/shared/USER.md', cwd));
  assert.ok(
    isUnderCacheDir(path.join(cacheDir(), 'skills', 'foo', 'SKILL.md')),
  );
  assert.ok(!isUnderCacheDir(path.join(cwd, 'notes.md')));
  assert.ok(!isUnderCacheDir(''));
});

test('writes and edits under var/cache are denied', async () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    assert.equal(
      await decide(tool, path.join(cwd, 'context', 'shared', 'USER.md')),
      'deny',
      tool,
    );
  }
  // A file that does not exist yet still resolves through the symlink.
  assert.equal(
    await decide(
      'Write',
      path.join(cwd, 'context', 'agents', 'coco', 'NEW.md'),
    ),
    'deny',
  );
});

test('everything outside var/cache is left alone', async () => {
  fs.writeFileSync(path.join(cwd, 'notes.md'), 'hi');
  assert.equal(await decide('Write', path.join(cwd, 'notes.md')), undefined);
  assert.equal(
    await decide('Read', path.join(cwd, 'context', 'shared', 'USER.md')),
    undefined,
  );
  assert.equal(await decide('Bash'), undefined);
  assert.equal(await decide('Write'), undefined);
});
