/**
 * Agent Runner for NanoClaw
 * Runs Claude Agent SDK directly in-process (no containers)
 */
import fs from 'fs';
import path from 'path';
import { query, HookCallback } from '@anthropic-ai/claude-agent-sdk';

import {
  AGENT_TIMEOUT,
  AGENTS_DIR,
  CONTEXT_DIR,
  DATA_DIR,
  NANOCLAW_HOME,
  TIMEZONE,
  localDate,
  localTime,
} from './config.js';
import { createIpcMcp } from './ipc-mcp.js';
import { emitEvent } from './db.js';
import { logger } from './logger.js';
import { Handler, RegisteredAgent } from './types.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  agentFolder: string;
  chatJid: string;
  isMain: boolean;
  isEventHandler?: boolean;
  model?: string;
  onText?: (text: string) => void;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  timedOut?: boolean;
  sentMediaViaIpc?: boolean;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

export function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    logger.debug({ err }, 'Failed to read sessions index');
  }

  return null;
}

function createSessionStartHook(agentDir: string): HookCallback {
  return async (_input, _toolUseId, _context) => {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().split('T')[0];
    const memoryDir = path.join(agentDir, 'memory');

    const parts: string[] = [];
    for (const date of [yesterday, today]) {
      const filePath = path.join(memoryDir, `${date}.md`);
      if (fs.existsSync(filePath)) {
        let content = fs.readFileSync(filePath, 'utf-8').trim();
        if (content) {
          if (content.length > 4000) {
            content = content.slice(-4000) + '\n[...truncated]';
          }
          parts.push(`=== memory/${date}.md ===\n${content}`);
        }
      }
    }

    if (parts.length === 0) return {};

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `Recent daily memory logs:\n\n${parts.join('\n\n')}`,
      },
    };
  };
}

export function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

export function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: TIMEZONE,
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

function buildContextPrompt(agentFolder: string): string {
  const parts: string[] = [];

  for (const file of ['AGENTS.md', 'SOUL.md', 'USER.md', 'MEMORY.md']) {
    const filePath = path.join(CONTEXT_DIR, file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (content) parts.push(content);
    }
  }

  const identityPath = path.join(AGENTS_DIR, agentFolder, 'IDENTITY.md');
  if (fs.existsSync(identityPath)) {
    const content = fs.readFileSync(identityPath, 'utf-8').trim();
    if (content) parts.push(content);
  }

  return parts.join('\n\n---\n\n');
}

export async function runContainerAgent(
  group: RegisteredAgent,
  input: ContainerInput,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const agentDir = path.join(AGENTS_DIR, group.folder);
  fs.mkdirSync(agentDir, { recursive: true });

  const logsDir = path.join(agentDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Set up per-agent IPC namespace
  const agentIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(agentIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(agentIpcDir, 'tasks'), { recursive: true });

  logger.info(
    {
      group: group.name,
      isMain: input.isMain,
    },
    'Running agent',
  );

  let sentMediaViaIpc = false;
  const ipcMcp = createIpcMcp({
    chatJid: input.chatJid,
    agentFolder: input.agentFolder,
    isMain: input.isMain,
    ipcDir: agentIpcDir,
    onSendMessage: ({ hasMedia }) => {
      if (hasMedia) sentMediaViaIpc = true;
    },
  });

  // Load user-configured MCP servers from ~/.nanoclaw/mcp.json
  let userMcpServers: Record<string, unknown> = {};
  try {
    const mcpConfigPath = path.join(NANOCLAW_HOME, 'mcp.json');
    const raw = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
    userMcpServers = raw.mcpServers || {};
  } catch {
    // No mcp.json or invalid — skip
  }

  let result: string | null = null;
  let newSessionId: string | undefined;

  const prompt = input.prompt;

  // Timeout via AbortController
  const abortController = new AbortController();
  const timeout = group.containerConfig?.timeout || AGENT_TIMEOUT;
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    logger.error({ group: group.name }, `Agent timeout after ${timeout}ms, aborting`);
    abortController.abort();
  }, timeout);

  try {
    logger.debug({ group: group.name }, 'Starting agent...');

    const contextPrompt = buildContextPrompt(input.agentFolder);
    const fullSystemPrompt = [contextPrompt, SYSTEM_PROMPT].filter(Boolean).join('\n\n---\n\n');

    let streamText = '';
    for await (const message of query({
      prompt,
      options: {
        abortController,
        cwd: agentDir,
        resume: input.sessionId,
        model: input.model || 'claude-opus-4-7',
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: fullSystemPrompt,
        },
        allowedTools: [
          'Bash',
          'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'Skill',
          'mcp__*'
        ],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project'],
        includePartialMessages: !!input.onText,
        mcpServers: {
          nanoclaw: ipcMcp,
          ...userMcpServers,
        },
        hooks: {
          SessionStart: [{ hooks: [createSessionStartHook(agentDir)] }],
        }
      }
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        logger.debug({ sessionId: newSessionId, group: group.name }, 'Session initialized');
      }

      if (input.onText && message.type === 'stream_event') {
        const event = (message as any).event;
        if (event?.type === 'message_start') {
          streamText = '';
        } else if (event?.type === 'content_block_delta' && event?.delta?.type === 'text_delta') {
          streamText += event.delta.text;
          if (streamText.trim()) input.onText(streamText);
        }
      }

      if ('result' in message && message.result) {
        result = message.result as string;
      }
    }

    clearTimeout(timeoutHandle);

    const duration = Date.now() - startTime;
    logger.info(
      {
        group: group.name,
        duration,
        status: 'success',
        hasResult: !!result,
      },
      'Agent completed',
    );

    // Write log file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(logsDir, `agent-${timestamp}.log`);
    const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

    const logLines = [
      `=== Agent Run Log ===`,
      `Timestamp: ${new Date().toISOString()}`,
      `Group: ${group.name}`,
      `IsMain: ${input.isMain}`,
      `Duration: ${duration}ms`,
      `Status: success`,
      ``,
    ];

    if (isVerbose) {
      logLines.push(
        `=== Input ===`,
        `Prompt length: ${input.prompt.length} chars`,
        `Session ID: ${input.sessionId || 'new'}`,
        `New Session ID: ${newSessionId || 'N/A'}`,
        ``,
      );
    }

    fs.writeFileSync(logFile, logLines.join('\n'));

    // Emit agent_complete event
    const triggerType = input.isEventHandler ? 'event_handler' : 'message';
    emitEvent('agent_complete', {
      group_folder: input.agentFolder,
      trigger_type: triggerType,
      status: 'success',
      duration_ms: duration,
    });

    return {
      status: 'success',
      result,
      newSessionId,
      sentMediaViaIpc,
    };

  } catch (err) {
    clearTimeout(timeoutHandle);

    const duration = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    logger.error(
      { group: group.name, duration, error: errorMessage },
      'Agent error',
    );

    // Write error log
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(logsDir, `agent-${timestamp}.log`);
    fs.writeFileSync(logFile, [
      `=== Agent Run Log ===`,
      `Timestamp: ${new Date().toISOString()}`,
      `Group: ${group.name}`,
      `IsMain: ${input.isMain}`,
      `Duration: ${duration}ms`,
      `Status: error`,
      `Error: ${errorMessage}`,
    ].join('\n'));

    // Emit agent_complete event (error path)
    const triggerType = input.isEventHandler ? 'event_handler' : 'message';
    emitEvent('agent_complete', {
      group_folder: input.agentFolder,
      trigger_type: triggerType,
      status: 'error',
      duration_ms: duration,
    });

    return {
      status: 'error',
      result: null,
      newSessionId,
      error: errorMessage,
      timedOut,
      sentMediaViaIpc,
    };
  }
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export function writeHandlersSnapshot(
  agentFolder: string,
  isMain: boolean,
  handlers: Handler[],
): void {
  const agentIpcDir = path.join(DATA_DIR, 'ipc', agentFolder);
  fs.mkdirSync(agentIpcDir, { recursive: true });

  const filteredHandlers = isMain
    ? handlers
    : handlers.filter((h) => h.group_folder === agentFolder);

  const handlersFile = path.join(agentIpcDir, 'current_handlers.json');
  fs.writeFileSync(
    handlersFile,
    JSON.stringify(
      filteredHandlers.map((h) => ({
        id: h.id,
        event_type: h.event_type,
        filter: h.filter,
        group_folder: h.group_folder,
        prompt: h.prompt.slice(0, 100),
        context_mode: h.context_mode,
        cron: h.cron,
        next_run: h.next_run,
        cooldown_ms: h.cooldown_ms,
        max_triggers: h.max_triggers,
        trigger_count: h.trigger_count,
        status: h.status,
      })),
      null,
      2,
    ),
  );
}

export function writeAgentsSnapshot(
  agentFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const agentIpcDir = path.join(DATA_DIR, 'ipc', agentFolder);
  fs.mkdirSync(agentIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(agentIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
