import fs from 'node:fs';
import path from 'node:path';

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

import { cacheDir } from '../store/paths.js';

// Tools that would edit a file in place. Everything under var/cache is a
// regenerated copy of a database row, so an edit there is silently reverted on
// the next materialize — better to refuse it and point at the MCP tool.
const GUARDED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export const CACHE_WRITE_DENIAL =
  'That path is a read-only mirror of the config database (regenerated from it, so edits there are lost). ' +
  'Use mcp__bearclaw__context_write for context files; skills are managed in the web admin.';

// path.resolve stops at symlinks, and the mirror is reached through one
// (var/agents/<folder>/context). Resolve the deepest existing ancestor for
// real, then re-attach the part that does not exist yet.
function realResolve(target: string): string {
  const absolute = path.resolve(target);
  let current = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export function isUnderCacheDir(filePath: string, cwd?: string): boolean {
  if (!filePath) return false;
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(cwd || process.cwd(), filePath);
  const resolved = realResolve(absolute);
  const root = realResolve(cacheDir());
  return resolved === root || resolved.startsWith(root + path.sep);
}

export function createCacheGuardHook(): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    if (!GUARDED_TOOLS.has(input.tool_name)) return {};
    const raw = (input.tool_input as { file_path?: unknown } | null)?.file_path;
    if (typeof raw !== 'string' || !raw) return {};
    if (!isUnderCacheDir(raw, input.cwd)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: CACHE_WRITE_DENIAL,
      },
    };
  };
}
