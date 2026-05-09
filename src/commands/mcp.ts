import fs from 'fs';
import path from 'path';

import { CONFIG_DIR } from '../config.js';
import { SlashCommand } from './types.js';

interface McpServer {
  command?: string;
  args?: string[];
  url?: string;
  type?: string;
}

interface McpConfig {
  mcpServers?: Record<string, McpServer>;
}

function loadMcpConfig(): McpConfig {
  const configPath = path.join(CONFIG_DIR, 'mcp.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as McpConfig;
  } catch {
    return {};
  }
}

function describeServer(name: string, s: McpServer): string {
  if (s.url) return `\`${name}\` — http \`${s.url}\``;
  const parts = [s.command, ...(s.args || [])].filter(Boolean) as string[];
  const cmd = parts.join(' ');
  const trimmed = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd;
  return `\`${name}\` — stdio \`${trimmed}\``;
}

export const mcpCommand: SlashCommand = {
  name: 'mcp',
  description: 'List configured MCP servers',
  handler: async ({ reply }) => {
    const cfg = loadMcpConfig();
    const servers = cfg.mcpServers || {};
    const names = Object.keys(servers).sort();
    const lines = [`**MCP servers (${names.length + 1})**`, ''];
    lines.push('• `nanoclaw` — built-in IPC (host ↔ agent)');
    for (const n of names) lines.push(`• ${describeServer(n, servers[n])}`);
    lines.push('');
    lines.push(`Config: \`${path.join(CONFIG_DIR, 'mcp.json')}\``);
    await reply(lines.join('\n'));
  },
};
