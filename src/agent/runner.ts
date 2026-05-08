/**
 * Agent Runner for NanoClaw
 * Runs Claude Agent SDK directly in-process (no containers)
 */
import fs from 'fs';
import path from 'path';
import { query, HookCallback } from '@anthropic-ai/claude-agent-sdk';

import {
  AGENT_TIMEOUT,
  CONFIG_DIR,
  CONTEXT_DIR,
  RUN_DIR,
  TIMEZONE,
  WARM_START_BUDGET_BYTES,
  WARM_START_DAYS,
  agentDir as agentPersistentDir,
  agentVarDir,
} from '../config.js';
import { createIpcMcp } from './ipc-mcp.js';
import { emitEvent } from '../db.js';
import { logger } from '../logger.js';
import { Handler, RegisteredAgent } from '../types.js';
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

export function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    logger.debug({ err }, 'Failed to read sessions index');
  }

  return null;
}

function readWithCap(filePath: string, cap: number): string | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return null;
  if (raw.length <= cap) return raw;
  return raw.slice(0, cap) + '\n[...truncated]';
}

function createSessionStartHook(varDir: string): HookCallback {
  return async (_input, _toolUseId, _context) => {
    const parts: string[] = [];
    let remaining = WARM_START_BUDGET_BYTES;

    // 1. Today's checkpoint (if a session crashed earlier today).
    const cpDir = path.join(varDir, 'checkpoints');
    if (fs.existsSync(cpDir) && remaining > 500) {
      for (const f of fs.readdirSync(cpDir)) {
        if (!f.endsWith('.md')) continue;
        const content = readWithCap(
          path.join(cpDir, f),
          Math.min(4000, remaining),
        );
        if (!content) continue;
        parts.push(`=== checkpoints/${f} ===\n${content}`);
        remaining -= content.length;
        if (remaining < 500) break;
      }
    }

    // 2. Last N days of conversation archives, oldest → newest so the most
    //    recent context lands closest to the live transcript.
    const conversationsDir = path.join(varDir, 'conversations');
    if (fs.existsSync(conversationsDir) && remaining > 500) {
      const days: string[] = [];
      for (let i = WARM_START_DAYS; i >= 0; i--) {
        days.push(
          new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10),
        );
      }
      const archives = fs
        .readdirSync(conversationsDir)
        .filter((f) => f.endsWith('.md'));
      for (const day of days) {
        const dayArchives = archives
          .filter((f) => f.startsWith(`${day}-`))
          .sort();
        for (const f of dayArchives) {
          const content = readWithCap(
            path.join(conversationsDir, f),
            Math.min(4000, remaining),
          );
          if (!content) continue;
          parts.push(`=== conversations/${f} ===\n${content}`);
          remaining -= content.length;
          if (remaining < 500) break;
        }
        if (remaining < 500) break;
      }
    }

    if (parts.length === 0) return {};

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `Warm-start context (recent checkpoint + conversation archives):\n\n${parts.join(
          '\n\n',
        )}`,
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
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {}
  }

  return messages;
}

export function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
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
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

function buildContextPrompt(agentFolder: string): string {
  const parts: string[] = [];

  for (const file of ['AGENTS.md', 'CONTEXT.md', 'SOUL.md', 'USER.md']) {
    const filePath = path.join(CONTEXT_DIR, file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (content) parts.push(content);
    }
  }

  const identityPath = path.join(
    agentPersistentDir(agentFolder),
    'IDENTITY.md',
  );
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

  const persistentDir = agentPersistentDir(group.folder);
  const varDir = agentVarDir(group.folder);
  fs.mkdirSync(persistentDir, { recursive: true });
  fs.mkdirSync(varDir, { recursive: true });

  const logsDir = path.join(varDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Set up per-agent IPC namespace
  const agentIpcDir = path.join(RUN_DIR, 'ipc', group.folder);
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

  // Load user-configured MCP servers from ~/.nanoclaw/config/mcp.json
  let userMcpServers: Record<string, unknown> = {};
  try {
    const mcpConfigPath = path.join(CONFIG_DIR, 'mcp.json');
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
    logger.error(
      { group: group.name },
      `Agent timeout after ${timeout}ms, aborting`,
    );
    abortController.abort();
  }, timeout);

  try {
    logger.debug({ group: group.name }, 'Starting agent...');

    const contextPrompt = buildContextPrompt(input.agentFolder);
    const fullSystemPrompt = [contextPrompt, SYSTEM_PROMPT]
      .filter(Boolean)
      .join('\n\n---\n\n');

    let streamText = '';
    for await (const message of query({
      prompt,
      options: {
        abortController,
        cwd: varDir,
        resume: input.sessionId,
        model: input.model || 'claude-opus-4-7',
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: fullSystemPrompt,
        },
        allowedTools: [
          'Bash',
          'Read',
          'Write',
          'Edit',
          'Glob',
          'Grep',
          'WebSearch',
          'WebFetch',
          'Skill',
          'mcp__*',
        ],
        // Treat the gbrain MCP as read-only: every mutating/admin op is
        // explicitly denied here so a hallucinated tool call cannot rewrite
        // pages, advance sync state, or queue jobs. Read ops (query, get_page,
        // list_pages, traverse_graph, get_timeline, etc.) remain available
        // via the `mcp__*` allowlist above.
        disallowedTools: [
          'mcp__gbrain__put_page',
          'mcp__gbrain__delete_page',
          'mcp__gbrain__restore_page',
          'mcp__gbrain__purge_deleted_pages',
          'mcp__gbrain__think',
          'mcp__gbrain__add_tag',
          'mcp__gbrain__remove_tag',
          'mcp__gbrain__add_link',
          'mcp__gbrain__remove_link',
          'mcp__gbrain__add_timeline_entry',
          'mcp__gbrain__revert_version',
          'mcp__gbrain__sync_brain',
          'mcp__gbrain__put_raw_data',
          'mcp__gbrain__log_ingest',
          'mcp__gbrain__file_upload',
          'mcp__gbrain__submit_job',
          'mcp__gbrain__cancel_job',
          'mcp__gbrain__retry_job',
          'mcp__gbrain__pause_job',
          'mcp__gbrain__resume_job',
          'mcp__gbrain__replay_job',
          'mcp__gbrain__send_job_message',
          'mcp__gbrain__sources_add',
          'mcp__gbrain__sources_remove',
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
          SessionStart: [{ hooks: [createSessionStartHook(varDir)] }],
        },
      },
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        logger.debug(
          { sessionId: newSessionId, group: group.name },
          'Session initialized',
        );
      }

      if (input.onText && message.type === 'stream_event') {
        const event = (message as any).event;
        if (event?.type === 'message_start') {
          streamText = '';
        } else if (
          event?.type === 'content_block_delta' &&
          event?.delta?.type === 'text_delta'
        ) {
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
    const isVerbose =
      process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

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
    fs.writeFileSync(
      logFile,
      [
        `=== Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Status: error`,
        `Error: ${errorMessage}`,
      ].join('\n'),
    );

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
  const agentIpcDir = path.join(RUN_DIR, 'ipc', agentFolder);
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
  const agentIpcDir = path.join(RUN_DIR, 'ipc', agentFolder);
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
