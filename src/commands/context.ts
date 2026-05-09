import fs from 'fs';
import os from 'os';
import path from 'path';

import { DEFAULT_MODEL } from '../agent/runner.js';
import { agentVarDir } from '../config.js';
import { SlashCommand } from './types.js';

interface Usage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

interface UsageSnapshot {
  usage: Usage;
  model?: string;
  timestamp?: string;
}

function sessionFilePath(sessionId: string, cwd: string): string {
  const encodedCwd = cwd.replace(/[/.]/g, '-');
  return path.join(
    os.homedir(),
    '.claude',
    'projects',
    encodedCwd,
    `${sessionId}.jsonl`,
  );
}

function findLastAssistantUsage(
  sessionId: string,
  cwd: string,
): UsageSnapshot | null {
  const file = sessionFilePath(sessionId, cwd);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf-8');
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln) continue;
    try {
      const obj = JSON.parse(ln);
      const msg = obj?.message;
      if (msg?.role === 'assistant' && msg.usage) {
        return {
          usage: msg.usage as Usage,
          model: msg.model,
          timestamp: obj?.timestamp,
        };
      }
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

const MODELS_1M = [
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-mythos',
];

function maxTokensForModel(model: string): number {
  return MODELS_1M.some((m) => model.startsWith(m)) ? 1_000_000 : 200_000;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function bar(pct: number, width = 20): string {
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round((clamped / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export const contextCommand: SlashCommand = {
  name: 'context',
  description: 'Show context window usage for the current session',
  handler: async ({ agent, getSessionId, getModel, reply }) => {
    const sid = getSessionId();
    if (!sid) {
      await reply(
        'No active session. Send a message first, or `/new` to start one.',
      );
      return;
    }
    const data = findLastAssistantUsage(sid, agentVarDir(agent.folder));
    if (!data) {
      await reply(`Session \`${sid.slice(0, 8)}\` has no assistant turns yet.`);
      return;
    }
    const configured = getModel();
    const model = configured || data.model || DEFAULT_MODEL;
    const max = maxTokensForModel(model);
    const inp = data.usage.input_tokens || 0;
    const cc = data.usage.cache_creation_input_tokens || 0;
    const cr = data.usage.cache_read_input_tokens || 0;
    const out = data.usage.output_tokens || 0;
    const total = inp + cc + cr;
    const pct = (total / max) * 100;

    const lines = [
      `**Context** \`${model}\``,
      `\`${bar(pct)}\` ${pct.toFixed(1)}%`,
      `${fmtTokens(total)} / ${fmtTokens(max)} tokens`,
      '',
      `• Cache read:  ${fmtTokens(cr)}`,
      `• Cache write: ${fmtTokens(cc)}`,
      `• Fresh input: ${fmtTokens(inp)}`,
      `• Last output: ${fmtTokens(out)}`,
      '',
      `Session: \`${sid.slice(0, 8)}\``,
    ];
    await reply(lines.join('\n'));
  },
};
