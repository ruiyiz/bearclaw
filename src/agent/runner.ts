/**
 * Agent Runner for NanoClaw
 * Runs Claude Agent SDK directly in-process (no containers)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getSessionMessages,
  query,
  HookCallback,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';

import {
  AGENT_TIMEOUT,
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
import { loadUserMcpServers } from './mcp-config.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

export const DEFAULT_MODEL = 'claude-opus-4-7';
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
  agentFolder: string;
  chatJid: string;
  isMain: boolean;
  isEventHandler?: boolean;
  model?: string;
  effort?: EffortLevel;
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
  cwd: string,
): string | null {
  const encodedCwd = cwd.replace(/[/.]/g, '-');
  const projectDir = path.join(os.homedir(), '.claude', 'projects', encodedCwd);
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

/**
 * Build warm-start text from recent conversation archives + checkpoints.
 * Archives sorted by date ascending; checkpoints by mtime ascending. By
 * construction (archives are the daily-flush product of checkpoints) every
 * archive is older than every checkpoint, so the simple two-stage append
 * yields a chronologically correct stream. Tail-capped at
 * WARM_START_BUDGET_BYTES so the most recent context survives truncation.
 */
export function buildWarmStartContext(varDir: string): string | null {
  const sections: string[] = [];

  const conversationsDir = path.join(varDir, 'conversations');
  if (fs.existsSync(conversationsDir)) {
    const cutoffMs = Date.now() - (WARM_START_DAYS + 1) * 86_400_000;
    const archives = fs
      .readdirSync(conversationsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const m = f.match(/^(\d{4}-\d{2}-\d{2})/);
        const ts = m ? Date.parse(`${m[1]}T00:00:00Z`) : NaN;
        return { f, ts };
      })
      .filter((x) => !Number.isNaN(x.ts) && x.ts >= cutoffMs)
      .sort((a, b) => a.ts - b.ts);
    for (const { f } of archives) {
      try {
        const raw = fs
          .readFileSync(path.join(conversationsDir, f), 'utf-8')
          .trim();
        if (!raw) continue;
        sections.push(`=== conversations/${f} ===\n${raw}`);
      } catch {
        // skip
      }
    }
  }

  const cpDir = path.join(varDir, 'checkpoints');
  if (fs.existsSync(cpDir)) {
    const checkpoints = fs
      .readdirSync(cpDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const fp = path.join(cpDir, f);
        let mtime = 0;
        try {
          mtime = fs.statSync(fp).mtimeMs;
        } catch {
          mtime = -1;
        }
        return { f, fp, mtime };
      })
      .filter((x) => x.mtime >= 0)
      .sort((a, b) => a.mtime - b.mtime);
    for (const { f, fp } of checkpoints) {
      try {
        const raw = fs.readFileSync(fp, 'utf-8').trim();
        if (!raw) continue;
        sections.push(`=== checkpoints/${f} ===\n${raw}`);
      } catch {
        // skip
      }
    }
  }

  if (sections.length === 0) return null;

  const merged = sections.join('\n\n');
  const tail =
    merged.length <= WARM_START_BUDGET_BYTES
      ? merged
      : '[...truncated]\n' + merged.slice(-WARM_START_BUDGET_BYTES);

  logger.info(
    {
      varDir,
      sections: sections.length,
      mergedBytes: merged.length,
      injectedBytes: tail.length,
      truncated: merged.length > WARM_START_BUDGET_BYTES,
    },
    'Warm-start context built',
  );

  return tail;
}

export function createSessionStartHook(varDir: string): HookCallback {
  return async (_input, _toolUseId, _context) => {
    const tail = buildWarmStartContext(varDir);
    if (!tail) return {};

    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `Warm-start context (recent checkpoint + conversation archives):\n\n${tail}`,
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

function formatTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: TIMEZONE,
  });
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
    const time = formatTime(msg.timestamp);
    const header = time ? `**${msg.sender}** (${time})` : `**${msg.sender}**`;
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`${header}: ${content}`);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

export async function writeTurnCheckpoint(
  varDir: string,
  sessionId: string,
): Promise<void> {
  const messages = await loadParsedTranscript(sessionId, varDir);
  if (messages.length === 0) return;

  const summary = getSessionSummary(sessionId, varDir);
  const cpDir = path.join(varDir, 'checkpoints');
  fs.mkdirSync(cpDir, { recursive: true });
  const cpPath = path.join(cpDir, `${sessionId}.md`);
  const tmp = `${cpPath}.tmp`;
  fs.writeFileSync(tmp, formatTranscriptMarkdown(messages, summary));
  fs.renameSync(tmp, cpPath);
}

export function buildContextPrompt(agentFolder: string): string {
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
  const userMcpServers = loadUserMcpServers();

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
        model: input.model || DEFAULT_MODEL,
        effort: maxEffort(
          input.effort || DEFAULT_EFFORT,
          detectEffortKeyword(input.prompt),
        ),
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

    // Crash safety: dump the current transcript to the session's checkpoint
    // file before the periodic flusher would otherwise tick. A session that
    // ends abruptly here (network blip, kernel signal) still leaves the
    // latest turn on disk for the daily consolidator to pick up. Run off the
    // critical path so the user-visible final reply isn't blocked on disk I/O.
    if (newSessionId) {
      const sid = newSessionId;
      void writeTurnCheckpoint(varDir, sid).catch((err) => {
        logger.warn({ err, group: group.name }, 'Per-turn checkpoint failed');
      });
    }

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

// Per-agent caches of the last-written snapshot JSON. We write only when the
// content differs, and we hand the actual disk write to fs.promises so the
// pre-query path doesn't block on it. The next IPC MCP read inside the agent
// happens hundreds of ms later (after SDK init + first tool dispatch), so a
// fire-and-forget write lands well before any reader.
const lastHandlersJson: Record<string, string> = {};
const lastGroupsJson: Record<string, string> = {};

export function writeHandlersSnapshot(
  agentFolder: string,
  isMain: boolean,
  handlers: Handler[],
): void {
  const filteredHandlers = isMain
    ? handlers
    : handlers.filter((h) => h.group_folder === agentFolder);

  const json = JSON.stringify(
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
  );
  if (lastHandlersJson[agentFolder] === json) return;
  lastHandlersJson[agentFolder] = json;

  const agentIpcDir = path.join(RUN_DIR, 'ipc', agentFolder);
  const handlersFile = path.join(agentIpcDir, 'current_handlers.json');
  void fs.promises
    .mkdir(agentIpcDir, { recursive: true })
    .then(() => fs.promises.writeFile(handlersFile, json))
    .catch((err) => {
      delete lastHandlersJson[agentFolder];
      logger.warn({ err, agentFolder }, 'Handlers snapshot write failed');
    });
}

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
