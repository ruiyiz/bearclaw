/**
 * Minimal Claude Agent SDK invocation for dream-cycle phases.
 *
 * Unlike runContainerAgent, this:
 *   - takes a fully restricted tool list (typically [] for REM, or just
 *     a single Write target for Narrate),
 *   - runs in a fresh session every time (no resume),
 *   - returns the raw text result.
 *
 * No IPC MCP server is wired up, so subagents have no path to send messages,
 * register handlers, or write memory through the normal agent surface.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

import { AGENT_TIMEOUT } from '../config.js';
import { logger } from '../logger.js';

interface DreamSubagentInput {
  prompt: string;
  cwd: string;
  systemPrompt: string;
  allowedTools: string[];
  timeoutMs?: number;
  model?: string;
}

interface DreamSubagentOutput {
  status: 'success' | 'error';
  result: string | null;
  error?: string;
}

export async function runDreamSubagent(
  input: DreamSubagentInput,
): Promise<DreamSubagentOutput> {
  const abortController = new AbortController();
  const timeoutMs = input.timeoutMs ?? AGENT_TIMEOUT;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);

  let result: string | null = null;
  try {
    for await (const message of query({
      prompt: input.prompt,
      options: {
        abortController,
        cwd: input.cwd,
        model: input.model || 'claude-opus-4-7',
        systemPrompt: input.systemPrompt,
        allowedTools: input.allowedTools,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
      },
    })) {
      if ('result' in message && message.result) {
        result = message.result as string;
      }
    }
    clearTimeout(timer);
    return { status: 'success', result };
  } catch (err) {
    clearTimeout(timer);
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn({ err: errorMessage, timedOut }, 'Dream subagent failed');
    return { status: 'error', result, error: errorMessage };
  }
}
