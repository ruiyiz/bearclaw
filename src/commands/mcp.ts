import { listMcpServers } from '../store/mcp.js';
import { SlashCommand } from './types.js';

interface McpServer {
  command?: string;
  args?: string[];
  url?: string;
  type?: string;
}

function describeServer(name: string, s: McpServer, enabled: boolean): string {
  const suffix = enabled ? '' : ' (disabled)';
  if (s.url) return `\`${name}\` — http \`${s.url}\`${suffix}`;
  const parts = [s.command, ...(s.args || [])].filter(Boolean) as string[];
  const cmd = parts.join(' ');
  const trimmed = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd;
  return `\`${name}\` — stdio \`${trimmed}\`${suffix}`;
}

export const mcpCommand: SlashCommand = {
  name: 'mcp',
  description: 'List configured MCP servers',
  handler: async ({ reply }) => {
    const rows = listMcpServers();
    const lines = [`**MCP servers (${rows.length + 1})**`, ''];
    lines.push('• `bearclaw` — built-in IPC (host ↔ agent)');
    for (const row of rows)
      lines.push(
        `• ${describeServer(row.name, row.config as McpServer, row.enabled)}`,
      );
    lines.push('');
    lines.push('Config: `bearclaw config mcp list`');
    await reply(lines.join('\n'));
  },
};
