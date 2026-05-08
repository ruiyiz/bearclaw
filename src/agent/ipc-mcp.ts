/**
 * IPC-based MCP Server for NanoClaw
 * Writes messages and tasks to files for the host process to pick up
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CronExpressionParser } from 'cron-parser';
import { GOOGLE_API_KEY, OPENAI_API_KEY, agentVarDir } from '../config.js';
import {
  startSubprocess,
  readSubprocessOutput,
  writeSubprocessInput,
  pollSubprocess,
  killSubprocess,
  listSubprocesses,
} from './subprocess-manager.js';
import { generateImage } from './image-gen.js';

interface IpcMcpContext {
  chatJid: string;
  agentFolder: string;
  isMain: boolean;
  ipcDir: string;
  onSendMessage?: (info: { hasMedia: boolean }) => void;
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

async function waitForResult(
  resultsDir: string,
  requestId: string,
  maxWait = 60000,
): Promise<{ success: boolean; message: string }> {
  const resultFile = path.join(resultsDir, `${requestId}.json`);
  const pollInterval = 1000;
  let elapsed = 0;

  while (elapsed < maxWait) {
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch (err) {
        return { success: false, message: `Failed to read result: ${err}` };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  return { success: false, message: 'Request timed out' };
}

function injectSettingsHooks(
  workdir: string,
  hooks: Record<string, string>,
  sessionId: string,
): void {
  const claudeDir = path.join(workdir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  const settingsFile = path.join(claudeDir, 'settings.local.json');
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as Record<
      string,
      unknown
    >;
  } catch {
    /* no existing settings */
  }

  const existing = (settings.hooks as Record<string, unknown[]>) || {};
  for (const [hookName, cmdTemplate] of Object.entries(hooks)) {
    const cmd = cmdTemplate.replace(/\{sessionId\}/g, sessionId);
    existing[hookName] = [{ hooks: [{ type: 'command', command: cmd }] }];
  }
  settings.hooks = existing;

  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

export function createIpcMcp(ctx: IpcMcpContext) {
  const { chatJid, agentFolder, isMain, ipcDir, onSendMessage } = ctx;
  const messagesDir = path.join(ipcDir, 'messages');
  const tasksDir = path.join(ipcDir, 'tasks');

  const emailResultsDir = path.join(ipcDir, 'email_results');

  return createSdkMcpServer({
    name: 'nanoclaw',
    version: '1.0.0',
    tools: [
      tool(
        'send_message',
        `Send a message to the user's chat.

IMPORTANT: Your final text output is automatically sent to the user. Do NOT use this tool for regular replies — you'll cause duplicate messages. Only use this tool for:
- Early acknowledgments during long tasks (then return "no response needed" as your final output)
- Sending media (images, documents)
- Communicating during scheduled/event-triggered tasks (where your return value is only logged)

MEDIA: Attach media by providing file_path (local file) or media_url (remote URL) along with media_type (image, document, video, audio).
The text parameter becomes the caption for media messages. For documents, also provide file_name.`,
        {
          text: z
            .string()
            .optional()
            .describe(
              'The message text to send (becomes caption for media messages)',
            ),
          sender: z
            .string()
            .optional()
            .describe(
              'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
            ),
          media_type: z
            .enum(['image', 'document', 'video', 'audio'])
            .optional()
            .describe('Type of media to attach'),
          file_path: z
            .string()
            .optional()
            .describe(
              'Local file path for the media (absolute or relative to agent folder)',
            ),
          media_url: z
            .string()
            .optional()
            .describe('URL of the media to send (alternative to file_path)'),
          file_name: z
            .string()
            .optional()
            .describe('Display file name for documents (e.g., "report.pdf")'),
          mimetype: z
            .string()
            .optional()
            .describe(
              'MIME type for documents (e.g., "application/pdf"). Auto-detected if omitted.',
            ),
          ptt: z
            .boolean()
            .optional()
            .describe('Send audio as a voice note (push-to-talk bubble)'),
        },
        async (args) => {
          // Validation: must have text or media
          if (!args.text && !args.media_type) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Must provide either text or media_type (or both).',
                },
              ],
              isError: true,
            };
          }
          // Validation: media requires a source
          if (args.media_type && !args.file_path && !args.media_url) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'media_type requires either file_path or media_url.',
                },
              ],
              isError: true,
            };
          }

          const data: Record<string, unknown> = {
            type: 'message',
            chatJid,
            text: args.text || null,
            sender: args.sender || undefined,
            agentFolder,
            timestamp: new Date().toISOString(),
          };

          if (args.media_type) {
            data.mediaType = args.media_type;
            data.filePath = args.file_path || null;
            data.mediaUrl = args.media_url || null;
            data.fileName = args.file_name || null;
            data.mimetype = args.mimetype || null;
            data.ptt = args.ptt || false;
          }

          const filename = writeIpcFile(messagesDir, data);
          onSendMessage?.({ hasMedia: !!args.media_type });

          return {
            content: [
              {
                type: 'text',
                text: `Message queued for delivery (${filename})`,
              },
            ],
          };
        },
      ),

      tool(
        'schedule_task',
        `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

RECURRING: Provide a cron expression.
ONE-TIME: Provide a run_at timestamp.

CONTEXT MODE:
• "agent" (recommended): Task runs with chat history and memory
• "isolated": Task runs in a fresh session (include all context in prompt)

CRON FORMAT (5-field, all times LOCAL timezone):
• "*/5 * * * *" = every 5 minutes
• "0 9 * * *" = daily at 9am
• "0 9 * * 1-5" = weekdays at 9am
• "0 */2 * * *" = every 2 hours`,
        {
          prompt: z
            .string()
            .describe('What the agent should do when the task runs'),
          cron: z
            .string()
            .optional()
            .describe(
              'Cron expression for recurring tasks (e.g., "0 9 * * *")',
            ),
          run_at: z
            .string()
            .optional()
            .describe(
              'Local timestamp for one-time tasks (e.g., "2026-02-01T15:30:00", no Z suffix)',
            ),
          context_mode: z
            .enum(['agent', 'isolated'])
            .default('agent')
            .describe('agent=shared session, isolated=fresh session'),
          target_agent: z
            .string()
            .optional()
            .describe(
              'Target agent folder (main only, defaults to current agent)',
            ),
        },
        async (args) => {
          if (!args.cron && !args.run_at) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Must provide either "cron" (recurring) or "run_at" (one-time).',
                },
              ],
              isError: true,
            };
          }

          // Validate cron expression
          if (args.cron) {
            try {
              CronExpressionParser.parse(args.cron);
            } catch {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Invalid cron: "${args.cron}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
                  },
                ],
                isError: true,
              };
            }
          }

          // Validate run_at timestamp
          if (args.run_at) {
            const date = new Date(args.run_at);
            if (isNaN(date.getTime())) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Invalid timestamp: "${args.run_at}". Use format like "2026-02-01T15:30:00".`,
                  },
                ],
                isError: true,
              };
            }
          }

          // Non-main agents can only schedule for themselves
          const targetAgent =
            isMain && args.target_agent ? args.target_agent : agentFolder;

          const data = {
            type: 'schedule_task',
            prompt: args.prompt,
            cron: args.cron || null,
            runAt: args.run_at || null,
            context_mode: args.context_mode || 'agent',
            agentFolder: targetAgent,
            createdBy: agentFolder,
            timestamp: new Date().toISOString(),
          };

          const filename = writeIpcFile(tasksDir, data);

          const scheduleDesc = args.cron
            ? `cron: ${args.cron}`
            : `run_at: ${args.run_at}`;
          return {
            content: [
              {
                type: 'text',
                text: `Task scheduled (${filename}): ${scheduleDesc}`,
              },
            ],
          };
        },
      ),

      // ─── Email tools ────────────────────────────────────────────────────

      tool(
        'reply_email',
        `Reply to an email. Use this when processing email_received events and a response is needed.
Sends the reply via Gmail, threading it under the original message.`,
        {
          message_id: z
            .string()
            .describe('The original message ID to reply to'),
          to: z.string().describe('Recipient email address'),
          subject: z
            .string()
            .describe('Email subject (use "Re: ..." for replies)'),
          body: z.string().describe('The reply body text'),
        },
        async (args) => {
          const requestId = `email-reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          writeIpcFile(tasksDir, {
            type: 'reply_email',
            requestId,
            messageId: args.message_id,
            to: args.to,
            subject: args.subject,
            body: args.body,
            agentFolder,
            timestamp: new Date().toISOString(),
          });

          const result = await waitForResult(emailResultsDir, requestId);
          return {
            content: [{ type: 'text', text: result.message }],
            isError: !result.success,
          };
        },
      ),

      // ─── Event handler tools ─────────────────────────────────────────────

      tool(
        'emit_event',
        `Emit a custom event into the event bus. Use this to chain pipeline steps.
Events are processed by registered handlers that match the event type.

Built-in event types (emitted automatically):
• cron_trigger — when a scheduled handler is due (payload: handler_id)
• handler_complete — after a handler finishes (payload: handler_id, group_folder, status, result_summary)
• agent_complete — after any agent run (payload: group_folder, trigger_type, status, duration_ms)

You can emit any custom event type for pipeline chaining (e.g., "earnings_released", "filings_collected").`,
        {
          type: z
            .string()
            .describe('Event type (e.g., "earnings_released", "data_ready")'),
          payload: z
            .record(z.string(), z.unknown())
            .default({})
            .describe('Event payload as key-value pairs'),
        },
        async (args) => {
          const data = {
            type: 'emit_event',
            eventType: args.type,
            payload: args.payload || {},
            agentFolder,
            timestamp: new Date().toISOString(),
          };

          writeIpcFile(tasksDir, data);

          return {
            content: [
              {
                type: 'text',
                text: `Event "${args.type}" emitted.`,
              },
            ],
          };
        },
      ),

      tool(
        'register_handler',
        `Register an event handler. When an event matching the type (and optional filter) is emitted, a new agent session runs with the handler's prompt and the event payload.

Use this to build multi-step pipelines where each step is independent with its own timeout and retry.

CONTEXT MODE:
• "agent": Handler runs in the agent's conversation context (shared session)
• "isolated" (default): Handler runs in a fresh session. Include all needed context in the prompt.

FILTER: Optional JSON object. All keys must match the event payload for the handler to trigger.
  Example: { "ticker": "AAPL" } — only triggers when payload contains ticker=AAPL.

COOLDOWN: Minimum milliseconds between triggers. Prevents rapid re-triggering.

MAX_TRIGGERS: Maximum number of times this handler can fire. After reaching the limit, it auto-completes.
  Set to 1 for one-shot handlers. Omit for unlimited.`,
        {
          event_type: z
            .string()
            .describe(
              'Event type to listen for (e.g., "earnings_released", "task_complete")',
            ),
          prompt: z
            .string()
            .describe(
              'Instructions for the agent when the event fires. The event payload will be injected automatically.',
            ),
          filter: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              'Optional filter: all keys must match event payload to trigger',
            ),
          context_mode: z
            .enum(['agent', 'isolated'])
            .default('isolated')
            .describe('agent=shared session, isolated=fresh session (default)'),
          cooldown_ms: z
            .number()
            .default(0)
            .describe('Minimum ms between triggers (default: 0)'),
          max_triggers: z
            .number()
            .optional()
            .describe('Max times this handler can fire. Omit for unlimited.'),
          target_agent: z
            .string()
            .optional()
            .describe(
              'Target agent folder (main only, defaults to current agent)',
            ),
        },
        async (args) => {
          // Non-main agents can only register handlers for themselves
          const targetAgent =
            isMain && args.target_agent ? args.target_agent : agentFolder;

          const data = {
            type: 'register_handler',
            eventType: args.event_type,
            prompt: args.prompt,
            filter: args.filter ? JSON.stringify(args.filter) : null,
            contextMode: args.context_mode || 'isolated',
            cooldownMs: args.cooldown_ms || 0,
            maxTriggers: args.max_triggers ?? null,
            targetAgent,
            createdBy: agentFolder,
            timestamp: new Date().toISOString(),
          };

          writeIpcFile(tasksDir, data);

          return {
            content: [
              {
                type: 'text',
                text: `Event handler registered for "${args.event_type}" in agent "${targetAgent}".`,
              },
            ],
          };
        },
      ),

      tool(
        'list_handlers',
        "List all registered handlers (both scheduled tasks and event handlers). From main: shows all. From other agents: shows only that agent's handlers.",
        {},
        async () => {
          const handlersFile = path.join(ipcDir, 'current_handlers.json');

          try {
            if (!fs.existsSync(handlersFile)) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'No handlers registered.',
                  },
                ],
              };
            }

            const allHandlers = JSON.parse(
              fs.readFileSync(handlersFile, 'utf-8'),
            );

            const handlers = isMain
              ? allHandlers
              : allHandlers.filter(
                  (h: { group_folder: string }) =>
                    h.group_folder === agentFolder,
                );

            if (handlers.length === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'No handlers registered.',
                  },
                ],
              };
            }

            const formatted = handlers
              .map(
                (h: {
                  id: string;
                  event_type: string;
                  cron: string | null;
                  next_run: string | null;
                  prompt: string;
                  status: string;
                  trigger_count: number;
                  max_triggers: number | null;
                }) => {
                  const schedule = h.cron
                    ? `cron: ${h.cron}, next: ${h.next_run || 'N/A'}`
                    : `on "${h.event_type}"`;
                  return `- [${h.id}] ${schedule}: ${h.prompt.slice(0, 50)}... - ${h.status} (fired ${h.trigger_count}${h.max_triggers !== null ? `/${h.max_triggers}` : ''} times)`;
                },
              )
              .join('\n');

            return {
              content: [
                {
                  type: 'text',
                  text: `Handlers:\n${formatted}`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error reading handlers: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }
        },
      ),

      tool(
        'pause_handler',
        'Pause an event handler. It will not trigger until resumed.',
        {
          handler_id: z.string().describe('The handler ID to pause'),
        },
        async (args) => {
          const data = {
            type: 'pause_handler',
            handlerId: args.handler_id,
            agentFolder,
            isMain,
            timestamp: new Date().toISOString(),
          };

          writeIpcFile(tasksDir, data);

          return {
            content: [
              {
                type: 'text',
                text: `Handler ${args.handler_id} pause requested.`,
              },
            ],
          };
        },
      ),

      tool(
        'resume_handler',
        'Resume a paused event handler.',
        {
          handler_id: z.string().describe('The handler ID to resume'),
        },
        async (args) => {
          const data = {
            type: 'resume_handler',
            handlerId: args.handler_id,
            agentFolder,
            isMain,
            timestamp: new Date().toISOString(),
          };

          writeIpcFile(tasksDir, data);

          return {
            content: [
              {
                type: 'text',
                text: `Handler ${args.handler_id} resume requested.`,
              },
            ],
          };
        },
      ),

      tool(
        'cancel_handler',
        'Cancel and delete an event handler.',
        {
          handler_id: z.string().describe('The handler ID to cancel'),
        },
        async (args) => {
          const data = {
            type: 'cancel_handler',
            handlerId: args.handler_id,
            agentFolder,
            isMain,
            timestamp: new Date().toISOString(),
          };

          writeIpcFile(tasksDir, data);

          return {
            content: [
              {
                type: 'text',
                text: `Handler ${args.handler_id} cancellation requested.`,
              },
            ],
          };
        },
      ),

      tool(
        'register_agent',
        `Register a new agent so it can respond to messages in a WhatsApp group. Main agent only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
        {
          jid: z
            .string()
            .describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
          name: z.string().describe('Display name for the agent'),
          folder: z
            .string()
            .describe(
              'Folder name for agent files (lowercase, hyphens, e.g., "family-chat")',
            ),
          trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
          active_hours_cron: z
            .union([z.string(), z.array(z.string())])
            .optional()
            .describe(
              'Cron expression(s) defining when the agent is active. Pass a string or array of strings (OR logic). E.g. ["* 18-22 * * 1-5", "* * * * 0,6"] for weekday evenings + all-day weekends.',
            ),
          active_hours_reply: z
            .string()
            .optional()
            .describe(
              'Custom auto-reply message sent when a message arrives outside active hours. Defaults to a message with the next active time.',
            ),
        },
        async (args) => {
          if (!isMain) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Only the main agent can register new agents.',
                },
              ],
              isError: true,
            };
          }

          const data: Record<string, unknown> = {
            type: 'register_agent',
            jid: args.jid,
            name: args.name,
            folder: args.folder,
            trigger: args.trigger,
            timestamp: new Date().toISOString(),
            ...(args.active_hours_cron
              ? {
                  activeHours: {
                    cron: args.active_hours_cron,
                    ...(args.active_hours_reply
                      ? { autoReply: args.active_hours_reply }
                      : {}),
                  },
                }
              : {}),
          };

          writeIpcFile(tasksDir, data);

          return {
            content: [
              {
                type: 'text',
                text: `Agent "${args.name}" registered. It will start receiving messages immediately.`,
              },
            ],
          };
        },
      ),

      // ─── Subprocess tools ────────────────────────────────────────────────

      tool(
        'subprocess_start',
        `Spawn a PTY subprocess and optionally register event handlers for completion/notifications.

PTY exit always fires a subprocess_exit event (universal). Additional notification wiring depends on the CLI tool — see the claude-code-cli and codex-cli skills for the exact parameters to pass.

on_exit: one-shot handler prompt that runs when the subprocess exits.
on_notification: repeating handler prompt that runs on each subprocess_notification event.
settings_hooks: written to {workdir}/.claude/settings.local.json before spawn (Claude Code). Map of hook name → command template with {sessionId} placeholder.
prompt_suffix: appended to the command string before spawn (other CLIs). Use {sessionId} placeholder.

Returns sessionId. Use subprocess_read/write/poll/kill to interact.`,
        {
          name: z
            .string()
            .optional()
            .describe(
              'Short human-readable name for this session (e.g. "auth-fix", "youtube-skill")',
            ),
          description: z
            .string()
            .optional()
            .describe(
              'What this session is doing — shown in subprocess_list so the agent can distinguish sessions',
            ),
          command: z.string().describe('Shell command to run'),
          workdir: z
            .string()
            .optional()
            .describe('Working directory (absolute or ~/relative)'),
          cols: z
            .number()
            .default(220)
            .describe('Terminal columns (default: 220)'),
          rows: z.number().default(50).describe('Terminal rows (default: 50)'),
          on_exit: z
            .string()
            .optional()
            .describe('Agent prompt to run when subprocess exits (one-shot)'),
          on_notification: z
            .string()
            .optional()
            .describe(
              'Agent prompt to run on each subprocess_notification event (repeating)',
            ),
          settings_hooks: z
            .record(z.string(), z.string())
            .optional()
            .describe(
              'Hook name → command template. Written to {workdir}/.claude/settings.local.json before spawn. Use {sessionId} in commands.',
            ),
          prompt_suffix: z
            .string()
            .optional()
            .describe(
              'Appended to command before spawn. Use {sessionId} as placeholder.',
            ),
        },
        async (args) => {
          try {
            const resolvedWorkdir = args.workdir
              ? path.resolve(args.workdir.replace(/^~/, os.homedir()))
              : undefined;

            const pre_spawn = args.settings_hooks
              ? (sessionId: string) =>
                  injectSettingsHooks(
                    resolvedWorkdir!,
                    args.settings_hooks!,
                    sessionId,
                  )
              : undefined;

            const sessionId = startSubprocess({
              name: args.name,
              description: args.description,
              command: args.command,
              workdir: args.workdir,
              agentFolder,
              chatJid,
              cols: args.cols,
              rows: args.rows,
              on_exit: args.on_exit,
              on_notification: args.on_notification,
              prompt_suffix: args.prompt_suffix,
              pre_spawn,
            });
            return {
              content: [{ type: 'text', text: JSON.stringify({ sessionId }) }],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Failed to start subprocess: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),

      tool(
        'subprocess_read',
        'Read buffered output from a subprocess. Use offset from previous call to get only new output.',
        {
          session_id: z.string().describe('Session ID from subprocess_start'),
          offset: z
            .number()
            .default(0)
            .describe('Byte offset from previous read (default: 0 = read all)'),
        },
        async (args) => {
          const result = readSubprocessOutput(args.session_id, args.offset);
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        },
      ),

      tool(
        'subprocess_write',
        'Write input to a running subprocess stdin. Use \\r for Enter.',
        {
          session_id: z.string().describe('Session ID from subprocess_start'),
          data: z
            .string()
            .describe('Data to write (use \\r for Enter, \\x03 for Ctrl+C)'),
        },
        async (args) => {
          const ok = writeSubprocessInput(args.session_id, args.data);
          return {
            content: [
              {
                type: 'text',
                text: ok ? 'Written.' : 'Subprocess not found or not running.',
              },
            ],
            isError: !ok,
          };
        },
      ),

      tool(
        'subprocess_poll',
        'Check the status of a subprocess (running/exited, exit code, PID).',
        {
          session_id: z.string().describe('Session ID from subprocess_start'),
        },
        async (args) => {
          const state = pollSubprocess(args.session_id);
          if (!state) {
            return {
              content: [{ type: 'text', text: 'Session not found.' }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(state) }],
          };
        },
      ),

      tool(
        'subprocess_kill',
        'Terminate a running subprocess.',
        {
          session_id: z.string().describe('Session ID from subprocess_start'),
        },
        async (args) => {
          const ok = killSubprocess(args.session_id);
          return {
            content: [
              {
                type: 'text',
                text: ok
                  ? 'Process killed.'
                  : 'Subprocess not found or already exited.',
              },
            ],
            isError: !ok,
          };
        },
      ),

      tool(
        'subprocess_list',
        'List all subprocess sessions (running and exited).',
        {},
        async () => {
          const sessions = listSubprocesses();
          if (sessions.length === 0) {
            return {
              content: [
                { type: 'text', text: 'No subprocess sessions found.' },
              ],
            };
          }
          const summary = sessions
            .map((s) => {
              const label = s.name
                ? `[${s.name}] ${s.sessionId}`
                : `[${s.sessionId}]`;
              const desc = s.description ? `\n  ${s.description}` : '';
              const detail = `${s.status} pid=${s.pid} workdir=${s.workdir || '~'}`;
              return `${label} ${detail}${desc}`;
            })
            .join('\n');
          return { content: [{ type: 'text', text: summary }] };
        },
      ),

      ...(OPENAI_API_KEY || GOOGLE_API_KEY
        ? [
            tool(
              'image_generate',
              `Generate an image from a text prompt.

PROVIDERS (selected via the model parameter):
- OpenAI gpt-image-2 (default when OPENAI_API_KEY is set) — supports size,
  quality, background, output_format.
- Google nano-banana (alias for gemini-2.5-flash-image) — fast, cheap,
  strong photorealism. Ignores size/quality/background/output_format
  (Gemini decides; output is PNG).
- Google nano-banana-2 (alias for gemini-3.1-flash-image-preview) — newer
  Flash Image model with stronger world knowledge and editing. Same
  constraints as nano-banana.
- Google nano-banana-pro (alias for gemini-3-pro-image-preview) — Pro tier;
  highest quality, slowest, costliest.

Pass model="nano-banana", "nano-banana-2", or any "gemini-*" id to use
Google. Pass "gpt-image-2" (or any "gpt-image-*") for OpenAI. Omit to use
the default for whichever key is configured.

DEFAULT (fire-and-forget): Returns immediately. Image is generated in the
background and delivered to the chat automatically when ready (~5–60s).
This frees you to finish your turn without waiting on the image API.

After calling this tool, write a short acknowledgment as your final reply
(e.g. "Generating — coming up.") and end the turn. Do NOT call send_message
for the image; it will be delivered automatically with the caption you
supplied.

Set wait=true if you need the file path back synchronously (e.g. to chain
edits or feed the image into another tool). In wait mode, you must call
send_message yourself to deliver it.

EDIT MODE: Pass input_images=["/path/to/img.jpg", ...] to feed reference
images into the model. The prompt then describes how to transform / combine
them. Required for identity-preserving edits (e.g. "make this person wear
a charcoal blazer" — without input_images the model just hallucinates a
new person). Paths may be absolute, ~-prefixed, relative to the agent
folder, or http(s) URLs. Gemini accepts multiple inputs (composition,
style transfer, multi-subject blends). OpenAI accepts one or more via the
edits endpoint.

Tips:
- Be specific in the prompt (subject, style, lighting, composition).
- For OpenAI: size="1024x1536" portrait, "1536x1024" landscape, "1024x1024" square, "auto".
- For OpenAI: quality="high" for fine detail; "low"/"medium" are faster/cheaper.
- For OpenAI: background="transparent" with output_format="png" or "webp" for cutouts.`,
              {
                prompt: z
                  .string()
                  .describe('Text description of the image to generate'),
                caption: z
                  .string()
                  .optional()
                  .describe(
                    'Caption sent with the image in fire-and-forget mode (ignored when wait=true)',
                  ),
                wait: z
                  .boolean()
                  .default(false)
                  .describe(
                    'If true, block until generation completes and return the file path. If false (default), return immediately and deliver the image asynchronously.',
                  ),
                model: z
                  .string()
                  .optional()
                  .describe(
                    'Model id. "gpt-image-2" (OpenAI default), "nano-banana" (gemini-2.5-flash-image), "nano-banana-2" (gemini-3.1-flash-image-preview), "nano-banana-pro" (gemini-3-pro-image-preview), or any other gpt-image-* / gemini-* id.',
                  ),
                size: z
                  .enum(['1024x1024', '1024x1536', '1536x1024', 'auto'])
                  .optional()
                  .describe('Output dimensions (OpenAI only; default: auto)'),
                quality: z
                  .enum(['low', 'medium', 'high', 'auto'])
                  .optional()
                  .describe('Generation quality (OpenAI only; default: auto)'),
                background: z
                  .enum(['transparent', 'opaque', 'auto'])
                  .optional()
                  .describe(
                    'Background mode (OpenAI only); transparent requires png or webp output',
                  ),
                output_format: z
                  .enum(['png', 'jpeg', 'webp'])
                  .optional()
                  .describe('Output file format (OpenAI only; default: png)'),
                input_images: z
                  .array(z.string())
                  .optional()
                  .describe(
                    'File paths (absolute, ~-prefixed, agent-folder-relative) or http(s) URLs to use as edit/reference inputs. When provided, the model edits/composes from these instead of generating from scratch.',
                  ),
              },
              async (args) => {
                const varDir = agentVarDir(agentFolder);
                const outputDir = path.join(varDir, 'media');

                // Pick a default model based on which key is configured.
                const requestedModel =
                  args.model ||
                  (OPENAI_API_KEY ? 'gpt-image-2' : 'nano-banana');
                const isGemini =
                  requestedModel.startsWith('nano-banana') ||
                  requestedModel.startsWith('gemini');
                // Gemini emits PNG; OpenAI honours output_format (default png).
                const ext = isGemini ? 'png' : args.output_format || 'png';

                const callArgs = {
                  prompt: args.prompt,
                  model: requestedModel,
                  size: args.size,
                  quality: args.quality,
                  background: args.background,
                  outputFormat: args.output_format,
                  outputDir,
                  inputImages: args.input_images,
                  baseDir: varDir,
                };

                if (args.wait) {
                  try {
                    const filepath = await generateImage(callArgs);
                    return {
                      content: [
                        {
                          type: 'text',
                          text: `Image generated at: ${filepath}\n\nDeliver it with send_message: media_type="image", file_path="${filepath}".`,
                        },
                      ],
                    };
                  } catch (err) {
                    const msg =
                      err instanceof Error ? err.message : String(err);
                    return {
                      content: [
                        {
                          type: 'text',
                          text: `Image generation failed: ${msg}`,
                        },
                      ],
                      isError: true,
                    };
                  }
                }

                // Fire-and-forget: kick off generation, deliver via IPC when ready.
                // The host process keeps the promise alive past the agent run.
                void (async () => {
                  try {
                    const filepath = await generateImage(callArgs);
                    writeIpcFile(messagesDir, {
                      type: 'message',
                      chatJid,
                      text: args.caption || null,
                      agentFolder,
                      timestamp: new Date().toISOString(),
                      mediaType: 'image',
                      filePath: filepath,
                      mediaUrl: null,
                      fileName: null,
                      mimetype: `image/${ext === 'jpeg' ? 'jpeg' : ext}`,
                      ptt: false,
                    });
                  } catch (err) {
                    const msg =
                      err instanceof Error ? err.message : String(err);
                    writeIpcFile(messagesDir, {
                      type: 'message',
                      chatJid,
                      text: `Image generation failed: ${msg}`,
                      agentFolder,
                      timestamp: new Date().toISOString(),
                    });
                  }
                })();

                return {
                  content: [
                    {
                      type: 'text',
                      text: `Image generation queued (${requestedModel}). It will be delivered to the chat automatically when ready (~5–60s). Do not call send_message for it.`,
                    },
                  ],
                };
              },
            ),
          ]
        : []),
    ],
  });
}
