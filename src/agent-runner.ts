/**
 * Agent Runner for NanoClaw
 * Runs Claude Agent SDK directly in-process (no containers)
 */
import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import {
  AGENT_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
} from './config.js';
import { createIpcMcp } from './ipc-mcp.js';
import { emitEvent } from './db.js';
import { logger } from './logger.js';
import { Handler, RegisteredGroup } from './types.js';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isEventHandler?: boolean;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
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

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
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

function createPreCompactHook(groupDir: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      logger.debug('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        logger.debug('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = path.join(groupDir, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      logger.debug({ filePath }, 'Archived conversation');
    } catch (err) {
      logger.error({ err }, 'Failed to archive transcript');
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
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

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
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

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Set up per-group IPC namespace
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });

  logger.info(
    {
      group: group.name,
      isMain: input.isMain,
    },
    'Running agent',
  );

  const ipcMcp = createIpcMcp({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain,
    ipcDir: groupIpcDir,
  });

  let result: string | null = null;
  let newSessionId: string | undefined;

  const prompt = input.prompt;

  // Timeout via AbortController
  const abortController = new AbortController();
  const timeout = group.containerConfig?.timeout || AGENT_TIMEOUT;
  const timeoutHandle = setTimeout(() => {
    logger.error({ group: group.name }, `Agent timeout after ${timeout}ms, aborting`);
    abortController.abort();
  }, timeout);

  try {
    logger.debug({ group: group.name }, 'Starting agent...');

    for await (const message of query({
      prompt,
      options: {
        abortController,
        cwd: groupDir,
        resume: input.sessionId,
        model: 'claude-opus-4-6',
        allowedTools: [
          'Bash',
          'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'mcp__nanoclaw__*'
        ],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project'],
        mcpServers: {
          nanoclaw: ipcMcp
        },
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook(groupDir)] }]
        }
      }
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        logger.debug({ sessionId: newSessionId, group: group.name }, 'Session initialized');
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
      group_folder: input.groupFolder,
      trigger_type: triggerType,
      status: 'success',
      duration_ms: duration,
    });

    return {
      status: 'success',
      result,
      newSessionId,
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
      group_folder: input.groupFolder,
      trigger_type: triggerType,
      status: 'error',
      duration_ms: duration,
    });

    return {
      status: 'error',
      result: null,
      newSessionId,
      error: errorMessage,
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
  groupFolder: string,
  isMain: boolean,
  handlers: Handler[],
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredHandlers = isMain
    ? handlers
    : handlers.filter((h) => h.group_folder === groupFolder);

  const handlersFile = path.join(groupIpcDir, 'current_handlers.json');
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

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
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
