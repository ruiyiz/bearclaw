/**
 * Agent Runner for BearClaw
 * Runs Claude Agent SDK directly in-process (no containers)
 */
import fs from 'fs';
import path from 'path';
import {
  getSessionMessages,
  query,
  HookCallback,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';

import {
  AGENT_TIMEOUT,
  DEFAULT_MODEL,
  RUN_DIR,
  TIMEZONE,
  requireModel,
  WARM_START_BUDGET_BYTES,
  WARM_START_DAYS,
  agentVarDir,
} from '../config.js';
import { getContextFile } from '../store/context.js';
import { ensureAgentVarLayout } from '../store/materialize.js';
import { createCacheGuardHook } from './hooks.js';
import { createIpcMcp } from './ipc-mcp.js';
import { emitEvent, getDb, type StoredMessage } from '../db.js';
import { logger } from '../logger.js';
import { RegisteredAgent } from '../types.js';
import { loadUserMcpServers } from './mcp-config.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

export { DEFAULT_MODEL };
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const DEFAULT_EFFORT: EffortLevel = 'low';
export const EFFORT_LEVELS: EffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

// Per-turn keyword bumps. Scans the prompt for trigger words and returns the
// highest implied effort, or undefined if no keyword present. Composes with
// the configured baseline via max().
export function detectEffortKeyword(prompt: string): EffortLevel | undefined {
  if (/\bultrathink\b/i.test(prompt)) return 'max';
  if (/\bthink harder\b/i.test(prompt)) return 'xhigh';
  if (/\bthink hard\b/i.test(prompt)) return 'high';
  if (/\bthink (?:more|deeply|carefully)\b/i.test(prompt)) return 'medium';
  return undefined;
}

export function maxEffort(a: EffortLevel, b?: EffortLevel): EffortLevel {
  if (!b) return a;
  return EFFORT_LEVELS.indexOf(a) >= EFFORT_LEVELS.indexOf(b) ? a : b;
}

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  // Workflow agent nodes: typed handoff, per-node tool and turn limits, and a
  // caller-owned abort signal.
  outputSchema?: Record<string, unknown>;
  allowedTools?: string[];
  maxTurns?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  agentFolder: string;
  chatJid: string;
  isMain: boolean;
  isEventHandler?: boolean;
  model?: string;
  effort?: EffortLevel;
  // Non-web jids registered to this agent folder. Used to populate the
  // warm-start hook with cross-channel context. Web jids are folded in via
  // a LIKE pattern by buildWarmStartContext, so callers don't need to
  // enumerate sessions here.
  imJids?: string[];
  onText?: (text: string) => void;
  onActivity?: (label: string) => void;
}

function trimLabel(s: string, n = 60): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function describeToolUse(b: {
  name?: string;
  input?: Record<string, unknown>;
}): string {
  const name = b.name || 'Tool';
  const input = (b.input || {}) as Record<string, string | undefined>;
  const baseFile = (p?: string) =>
    p ? p.split('/').filter(Boolean).pop() || p : '';
  switch (name) {
    case 'Bash':
      return `Bash: ${trimLabel(input.description || input.command || '')}`;
    case 'Read':
      return `Read ${baseFile(input.file_path)}`;
    case 'Write':
      return `Write ${baseFile(input.file_path)}`;
    case 'Edit':
      return `Edit ${baseFile(input.file_path)}`;
    case 'Glob':
      return `Glob ${trimLabel(input.pattern || '')}`;
    case 'Grep':
      return `Grep ${trimLabel(input.pattern || '')}`;
    case 'WebSearch':
      return `Search: ${trimLabel(input.query || '')}`;
    case 'WebFetch': {
      try {
        const u = new URL(input.url || '');
        return `Fetch ${u.hostname}`;
      } catch {
        return 'Fetch';
      }
    }
    case 'Skill':
      return `Skill: ${trimLabel(input.skill || input.name || '')}`;
    default:
      if (name.startsWith('mcp__')) {
        const parts = name.split('__');
        return parts.slice(-1)[0];
      }
      return name;
  }
}

export function describeBlock(b: {
  type?: string;
  name?: string;
  input?: Record<string, unknown>;
}): string | null {
  if (!b?.type) return null;
  if (b.type === 'thinking') return 'Thinking';
  // Skip text blocks: progress mode replaces the placeholder with the full
  // reply right after the stream ends, so a "Replying" indicator would only
  // flash for a moment before being overwritten.
  if (b.type === 'text') return null;
  if (b.type === 'tool_use') return describeToolUse(b);
  return null;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  structuredOutput?: unknown;
  newSessionId?: string;
  error?: string;
  timedOut?: boolean;
  sentMediaViaIpc?: boolean;
}

/**
 * Build warm-start text from the messages DB. Pulls the last N days of
 * exchanges for the agent folder — IM jids passed in by the caller plus every
 * `web:<folder>:*` composite jid — and tail-caps at WARM_START_BUDGET_BYTES so
 * the most recent turns survive truncation.
 */
export function buildWarmStartContext(
  folder: string,
  imJids: string[],
): string | null {
  const cutoffMs = Date.now() - WARM_START_DAYS * 86_400_000;
  const sinceIso = new Date(cutoffMs).toISOString();
  const db = getDb();

  const placeholders = imJids.length ? imJids.map(() => '?').join(',') : `''`;
  const sql = `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
               FROM messages
               WHERE timestamp >= ?
                 AND (chat_jid LIKE ? OR chat_jid IN (${placeholders}))
               ORDER BY timestamp`;
  const rows = db
    .prepare(sql)
    .all(sinceIso, `web:${folder}:%`, ...imJids) as StoredMessage[];

  if (rows.length === 0) return null;

  const lines = rows.map((m) => {
    const who = m.is_from_me === 1 ? 'Assistant' : m.sender_name || m.sender;
    return `**${who}** [${m.timestamp}]\n\n${m.content}`;
  });
  const merged = lines.join('\n\n---\n\n');
  const tail =
    merged.length <= WARM_START_BUDGET_BYTES
      ? merged
      : '[...truncated]\n' + merged.slice(-WARM_START_BUDGET_BYTES);

  logger.info(
    {
      folder,
      rows: rows.length,
      mergedBytes: merged.length,
      injectedBytes: tail.length,
      truncated: merged.length > WARM_START_BUDGET_BYTES,
    },
    'Warm-start context built (DB)',
  );

  return tail;
}

export function createSessionStartHook(
  folder: string,
  imJids: string[],
): HookCallback {
  return async (_input, _toolUseId, _context) => {
    const tail = buildWarmStartContext(folder, imJids);
    if (!tail) return {};

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `Warm-start context (recent conversation history):\n\n${tail}`,
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

export interface ParsedMessage {
  // sender: human name (from <message sender="..."> wrapper) or 'Assistant'.
  sender: string;
  // ISO timestamp. For user turns, taken from inner <message time="...">; for
  // assistant turns, from the SessionMessage's top-level `timestamp`.
  timestamp: string;
  content: string;
}

// SessionMessage's TS shape omits `timestamp`, but the runtime payload includes
// it (we depend on it for per-turn time prefixes).
type SessionMessageWithTs = SessionMessage & { timestamp?: string };

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The chat router wraps incoming user content as
 *   <messages><message sender="..." time="...">text</message>...</messages>
 * so each user turn carries the (possibly cumulative) batch of unread messages
 * since the last agent reply. Expand the wrapper into individual entries so
 * the archive doesn't show raw XML.
 */
function expandUserMessages(
  raw: string,
  fallbackTimestamp: string,
): { sender: string; timestamp: string; content: string }[] | null {
  const wrapper = raw.match(/^<messages>\s*([\s\S]*?)\s*<\/messages>\s*$/);
  if (!wrapper) return null;
  const inner = wrapper[1];
  const out: { sender: string; timestamp: string; content: string }[] = [];
  const re =
    /<message\s+sender="([^"]*)"\s+time="([^"]*)"\s*>([\s\S]*?)<\/message>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    out.push({
      sender: unescapeXml(m[1]),
      timestamp: m[2] || fallbackTimestamp,
      content: unescapeXml(m[3]).trim(),
    });
  }
  return out.length > 0 ? out : null;
}

/**
 * Load the session's user/assistant turns via the SDK, normalize them, and
 * expand <messages>-wrapped user payloads into individual entries.
 *
 * Sidechain (subagent) turns are excluded by SDK contract — getSessionMessages
 * returns main-thread only; getSubagentMessages handles those separately.
 */
export async function loadParsedTranscript(
  sessionId: string,
  dir: string,
): Promise<ParsedMessage[]> {
  const sessionMessages = (await getSessionMessages(sessionId, {
    dir,
  })) as SessionMessageWithTs[];

  const out: ParsedMessage[] = [];
  // Dedup key for repeats that the chat router re-includes in successive
  // <messages> blocks until the agent replies.
  const seen = new Set<string>();
  const keyOf = (sender: string, ts: string, text: string) =>
    `${sender}|${ts}|${text}`;

  for (const entry of sessionMessages) {
    const entryTs = entry.timestamp || '';
    const msg = entry.message as
      | { role?: string; content?: unknown }
      | undefined;
    if (!msg?.content) continue;

    if (entry.type === 'user') {
      // Strip tool_result / tool_use echoes — SDK plumbing, not user speech.
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : (msg.content as { type?: string; text?: string }[])
              .filter((c) => c.type !== 'tool_result' && c.type !== 'tool_use')
              .map((c) => c.text || '')
              .join('');
      if (!text) continue;

      const expanded = expandUserMessages(text.trim(), entryTs);
      if (expanded) {
        for (const m of expanded) {
          if (!m.content) continue;
          const k = keyOf(m.sender, m.timestamp, m.content);
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({
            sender: m.sender,
            timestamp: m.timestamp,
            content: m.content,
          });
        }
      } else {
        const k = keyOf('User', entryTs, text);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ sender: 'User', timestamp: entryTs, content: text });
      }
    } else if (entry.type === 'assistant') {
      const blocks = msg.content as { type?: string; text?: string }[];
      const text = blocks
        .filter((c) => c.type === 'text')
        .map((c) => c.text || '')
        .join('')
        .trim();
      if (text) {
        out.push({ sender: 'Assistant', timestamp: entryTs, content: text });
      }
    }
  }

  return out;
}

export function buildContextPrompt(agentFolder: string): string {
  const parts: string[] = [];

  for (const file of ['AGENTS.md', 'CONTEXT.md', 'SOUL.md', 'USER.md']) {
    const content = getContextFile('shared', '', file)?.trim();
    if (content) parts.push(content);
  }

  const identity = getContextFile('agent', agentFolder, 'IDENTITY.md')?.trim();
  if (identity) parts.push(identity);

  return parts.join('\n\n---\n\n');
}

export async function runContainerAgent(
  group: RegisteredAgent,
  input: ContainerInput,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const varDir = agentVarDir(group.folder);
  ensureAgentVarLayout(group.folder);
  const logsDir = path.join(varDir, 'logs');

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

  // Load user-configured MCP servers from ~/.bearclaw/config/mcp.json
  const userMcpServers = loadUserMcpServers();

  let result: string | null = null;
  let structuredOutput: unknown;
  let newSessionId: string | undefined;

  const prompt = input.prompt;

  // Timeout via AbortController
  const abortController = new AbortController();
  if (input.abortSignal) {
    if (input.abortSignal.aborted) abortController.abort();
    else
      input.abortSignal.addEventListener(
        'abort',
        () => abortController.abort(),
        {
          once: true,
        },
      );
  }
  const timeout =
    input.timeoutMs || group.containerConfig?.timeout || AGENT_TIMEOUT;
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
        model: requireModel(input.model),
        effort: maxEffort(
          input.effort || DEFAULT_EFFORT,
          detectEffortKeyword(input.prompt),
        ),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: fullSystemPrompt,
        },
        ...(input.outputSchema
          ? {
              outputFormat: {
                type: 'json_schema' as const,
                schema: input.outputSchema,
              },
            }
          : {}),
        ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
        allowedTools: input.allowedTools ?? [
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
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project'],
        includePartialMessages: !!input.onText,
        mcpServers: {
          bearclaw: ipcMcp,
          ...userMcpServers,
        },
        hooks: {
          SessionStart: [
            {
              hooks: [
                createSessionStartHook(input.agentFolder, input.imJids ?? []),
              ],
            },
          ],
          PreToolUse: [{ hooks: [createCacheGuardHook()] }],
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

      if (input.onActivity && message.type === 'assistant') {
        const blocks = (message as { message?: { content?: unknown } })?.message
          ?.content;
        if (Array.isArray(blocks)) {
          let label: string | null = null;
          for (const b of blocks) {
            const l = describeBlock(b as { type?: string });
            if (l) label = l;
          }
          if (label) input.onActivity(label);
        }
      }

      if ('result' in message && message.result) {
        result = message.result as string;
      }
      if (message.type === 'result' && 'structured_output' in message) {
        structuredOutput = message.structured_output;
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
      structuredOutput,
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

// Per-agent cache of the last-written snapshot JSON. We write only when the
// content differs, and we hand the actual disk write to fs.promises so the
// pre-query path doesn't block on it. The next IPC MCP read inside the agent
// happens hundreds of ms later (after SDK init + first tool dispatch), so a
// fire-and-forget write lands well before any reader.
const lastGroupsJson: Record<string, string> = {};

export function writeAgentsSnapshot(
  agentFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const visibleGroups = isMain ? groups : [];
  // lastSync intentionally omitted from the diff key so a timestamp-only
  // change doesn't trigger a write every turn.
  const payloadJson = JSON.stringify(visibleGroups);
  if (lastGroupsJson[agentFolder] === payloadJson) return;
  lastGroupsJson[agentFolder] = payloadJson;

  const agentIpcDir = path.join(RUN_DIR, 'ipc', agentFolder);
  const groupsFile = path.join(agentIpcDir, 'available_groups.json');
  const fullJson = JSON.stringify(
    { groups: visibleGroups, lastSync: new Date().toISOString() },
    null,
    2,
  );
  void fs.promises
    .mkdir(agentIpcDir, { recursive: true })
    .then(() => fs.promises.writeFile(groupsFile, fullJson))
    .catch((err) => {
      delete lastGroupsJson[agentFolder];
      logger.warn({ err, agentFolder }, 'Groups snapshot write failed');
    });
}
