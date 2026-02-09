/**
 * IPC-based MCP Server for NanoClaw
 * Writes messages and tasks to files for the host process to pick up
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

export interface IpcMcpContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  ipcDir: string;
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

async function waitForResult(resultsDir: string, requestId: string, maxWait = 60000): Promise<{ success: boolean; message: string }> {
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
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    elapsed += pollInterval;
  }

  return { success: false, message: 'Request timed out' };
}

export function createIpcMcp(ctx: IpcMcpContext) {
  const { chatJid, groupFolder, isMain, ipcDir } = ctx;
  const messagesDir = path.join(ipcDir, 'messages');
  const tasksDir = path.join(ipcDir, 'tasks');

  const emailResultsDir = path.join(ipcDir, 'email_results');

  return createSdkMcpServer({
    name: 'nanoclaw',
    version: '1.0.0',
    tools: [
      tool(
        'send_message',
        `Send a message to a WhatsApp group.

IMPORTANT: Your final text output is automatically sent to the user. Do NOT use this tool for regular replies — you'll cause duplicate messages. Only use this tool for:
- Cross-group messaging (sending to a different group via target_chat)
- Early acknowledgments during long tasks (then return "no response needed" as your final output)
- Sending media (images, documents)
- Communicating during scheduled/event-triggered tasks (where your return value is only logged)

Main group agents can send to any registered group by specifying target_chat (the group folder name).

MEDIA: Attach an image or document by providing file_path (local file) or media_url (remote URL) along with media_type.
The text parameter becomes the caption for media messages. For documents, also provide file_name.`,
        {
          text: z.string().optional().describe('The message text to send (becomes caption for media messages)'),
          target_chat: z.string().optional().describe('Target group folder (main only, defaults to current group)'),
          media_type: z.enum(['image', 'document']).optional().describe('Type of media to attach'),
          file_path: z.string().optional().describe('Local file path for the media (absolute or relative to group folder)'),
          media_url: z.string().optional().describe('URL of the media to send (alternative to file_path)'),
          file_name: z.string().optional().describe('Display file name for documents (e.g., "report.pdf")'),
          mimetype: z.string().optional().describe('MIME type for documents (e.g., "application/pdf"). Auto-detected if omitted.')
        },
        async (args) => {
          // Validation: must have text or media
          if (!args.text && !args.media_type) {
            return {
              content: [{ type: 'text', text: 'Must provide either text or media_type (or both).' }],
              isError: true
            };
          }
          // Validation: media requires a source
          if (args.media_type && !args.file_path && !args.media_url) {
            return {
              content: [{ type: 'text', text: 'media_type requires either file_path or media_url.' }],
              isError: true
            };
          }

          // Non-main groups can only send to their own chat
          const targetFolder = isMain && args.target_chat ? args.target_chat : groupFolder;

          const data: Record<string, unknown> = {
            type: 'message',
            chatJid,
            targetFolder,
            text: args.text || null,
            groupFolder,
            timestamp: new Date().toISOString()
          };

          if (args.media_type) {
            data.mediaType = args.media_type;
            data.filePath = args.file_path || null;
            data.mediaUrl = args.media_url || null;
            data.fileName = args.file_name || null;
            data.mimetype = args.mimetype || null;
          }

          const filename = writeIpcFile(messagesDir, data);

          return {
            content: [{
              type: 'text',
              text: `Message queued for delivery to ${targetFolder} (${filename})`
            }]
          };
        }
      ),

      tool(
        'schedule_task',
        `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

RECURRING: Provide a cron expression.
ONE-TIME: Provide a run_at timestamp.

CONTEXT MODE:
• "group" (recommended): Task runs with chat history and memory
• "isolated": Task runs in a fresh session (include all context in prompt)

CRON FORMAT (5-field, all times LOCAL timezone):
• "*/5 * * * *" = every 5 minutes
• "0 9 * * *" = daily at 9am
• "0 9 * * 1-5" = weekdays at 9am
• "0 */2 * * *" = every 2 hours`,
        {
          prompt: z.string().describe('What the agent should do when the task runs'),
          cron: z.string().optional().describe('Cron expression for recurring tasks (e.g., "0 9 * * *")'),
          run_at: z.string().optional().describe('Local timestamp for one-time tasks (e.g., "2026-02-01T15:30:00", no Z suffix)'),
          context_mode: z.enum(['group', 'isolated']).default('group').describe('group=shared session, isolated=fresh session'),
          target_group: z.string().optional().describe('Target group folder (main only, defaults to current group)')
        },
        async (args) => {
          if (!args.cron && !args.run_at) {
            return {
              content: [{ type: 'text', text: 'Must provide either "cron" (recurring) or "run_at" (one-time).' }],
              isError: true
            };
          }

          // Validate cron expression
          if (args.cron) {
            try {
              CronExpressionParser.parse(args.cron);
            } catch {
              return {
                content: [{ type: 'text', text: `Invalid cron: "${args.cron}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
                isError: true
              };
            }
          }

          // Validate run_at timestamp
          if (args.run_at) {
            const date = new Date(args.run_at);
            if (isNaN(date.getTime())) {
              return {
                content: [{ type: 'text', text: `Invalid timestamp: "${args.run_at}". Use format like "2026-02-01T15:30:00".` }],
                isError: true
              };
            }
          }

          // Non-main groups can only schedule for themselves
          const targetGroup = isMain && args.target_group ? args.target_group : groupFolder;

          const data = {
            type: 'schedule_task',
            prompt: args.prompt,
            cron: args.cron || null,
            runAt: args.run_at || null,
            context_mode: args.context_mode || 'group',
            groupFolder: targetGroup,
            createdBy: groupFolder,
            timestamp: new Date().toISOString()
          };

          const filename = writeIpcFile(tasksDir, data);

          const scheduleDesc = args.cron ? `cron: ${args.cron}` : `run_at: ${args.run_at}`;
          return {
            content: [{
              type: 'text',
              text: `Task scheduled (${filename}): ${scheduleDesc}`
            }]
          };
        }
      ),

      // ─── Email tools ────────────────────────────────────────────────────

      tool(
        'reply_email',
        `Reply to an email. Use this when processing email_received events and a response is needed.
Sends the reply via Gmail, threading it under the original message.`,
        {
          message_id: z.string().describe('The original message ID to reply to'),
          to: z.string().describe('Recipient email address'),
          subject: z.string().describe('Email subject (use "Re: ..." for replies)'),
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
            groupFolder,
            timestamp: new Date().toISOString(),
          });

          const result = await waitForResult(emailResultsDir, requestId);
          return {
            content: [{ type: 'text', text: result.message }],
            isError: !result.success,
          };
        }
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
          type: z.string().describe('Event type (e.g., "earnings_released", "data_ready")'),
          payload: z.record(z.string(), z.unknown()).default({}).describe('Event payload as key-value pairs')
        },
        async (args) => {
          const data = {
            type: 'emit_event',
            eventType: args.type,
            payload: args.payload || {},
            groupFolder,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(tasksDir, data);

          return {
            content: [{
              type: 'text',
              text: `Event "${args.type}" emitted.`
            }]
          };
        }
      ),

      tool(
        'register_handler',
        `Register an event handler. When an event matching the type (and optional filter) is emitted, a new agent session runs with the handler's prompt and the event payload.

Use this to build multi-step pipelines where each step is independent with its own timeout and retry.

CONTEXT MODE:
• "group": Handler runs in the group's conversation context (shared session)
• "isolated" (default): Handler runs in a fresh session. Include all needed context in the prompt.

FILTER: Optional JSON object. All keys must match the event payload for the handler to trigger.
  Example: { "ticker": "AAPL" } — only triggers when payload contains ticker=AAPL.

COOLDOWN: Minimum milliseconds between triggers. Prevents rapid re-triggering.

MAX_TRIGGERS: Maximum number of times this handler can fire. After reaching the limit, it auto-completes.
  Set to 1 for one-shot handlers. Omit for unlimited.`,
        {
          event_type: z.string().describe('Event type to listen for (e.g., "earnings_released", "task_complete")'),
          prompt: z.string().describe('Instructions for the agent when the event fires. The event payload will be injected automatically.'),
          filter: z.record(z.string(), z.unknown()).optional().describe('Optional filter: all keys must match event payload to trigger'),
          context_mode: z.enum(['group', 'isolated']).default('isolated').describe('group=shared session, isolated=fresh session (default)'),
          cooldown_ms: z.number().default(0).describe('Minimum ms between triggers (default: 0)'),
          max_triggers: z.number().optional().describe('Max times this handler can fire. Omit for unlimited.'),
          target_group: z.string().optional().describe('Target group folder (main only, defaults to current group)')
        },
        async (args) => {
          // Non-main groups can only register handlers for themselves
          const targetGroup = isMain && args.target_group ? args.target_group : groupFolder;

          const data = {
            type: 'register_handler',
            eventType: args.event_type,
            prompt: args.prompt,
            filter: args.filter ? JSON.stringify(args.filter) : null,
            contextMode: args.context_mode || 'isolated',
            cooldownMs: args.cooldown_ms || 0,
            maxTriggers: args.max_triggers ?? null,
            targetGroup,
            createdBy: groupFolder,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(tasksDir, data);

          return {
            content: [{
              type: 'text',
              text: `Event handler registered for "${args.event_type}" in group "${targetGroup}".`
            }]
          };
        }
      ),

      tool(
        'list_handlers',
        'List all registered handlers (both scheduled tasks and event handlers). From main: shows all. From other groups: shows only that group\'s handlers.',
        {},
        async () => {
          const handlersFile = path.join(ipcDir, 'current_handlers.json');

          try {
            if (!fs.existsSync(handlersFile)) {
              return {
                content: [{
                  type: 'text',
                  text: 'No handlers registered.'
                }]
              };
            }

            const allHandlers = JSON.parse(fs.readFileSync(handlersFile, 'utf-8'));

            const handlers = isMain
              ? allHandlers
              : allHandlers.filter((h: { group_folder: string }) => h.group_folder === groupFolder);

            if (handlers.length === 0) {
              return {
                content: [{
                  type: 'text',
                  text: 'No handlers registered.'
                }]
              };
            }

            const formatted = handlers.map((h: { id: string; event_type: string; cron: string | null; next_run: string | null; prompt: string; status: string; trigger_count: number; max_triggers: number | null }) => {
              const schedule = h.cron ? `cron: ${h.cron}, next: ${h.next_run || 'N/A'}` : `on "${h.event_type}"`;
              return `- [${h.id}] ${schedule}: ${h.prompt.slice(0, 50)}... - ${h.status} (fired ${h.trigger_count}${h.max_triggers !== null ? `/${h.max_triggers}` : ''} times)`;
            }).join('\n');

            return {
              content: [{
                type: 'text',
                text: `Handlers:\n${formatted}`
              }]
            };
          } catch (err) {
            return {
              content: [{
                type: 'text',
                text: `Error reading handlers: ${err instanceof Error ? err.message : String(err)}`
              }]
            };
          }
        }
      ),

      tool(
        'pause_handler',
        'Pause an event handler. It will not trigger until resumed.',
        {
          handler_id: z.string().describe('The handler ID to pause')
        },
        async (args) => {
          const data = {
            type: 'pause_handler',
            handlerId: args.handler_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(tasksDir, data);

          return {
            content: [{
              type: 'text',
              text: `Handler ${args.handler_id} pause requested.`
            }]
          };
        }
      ),

      tool(
        'resume_handler',
        'Resume a paused event handler.',
        {
          handler_id: z.string().describe('The handler ID to resume')
        },
        async (args) => {
          const data = {
            type: 'resume_handler',
            handlerId: args.handler_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(tasksDir, data);

          return {
            content: [{
              type: 'text',
              text: `Handler ${args.handler_id} resume requested.`
            }]
          };
        }
      ),

      tool(
        'cancel_handler',
        'Cancel and delete an event handler.',
        {
          handler_id: z.string().describe('The handler ID to cancel')
        },
        async (args) => {
          const data = {
            type: 'cancel_handler',
            handlerId: args.handler_id,
            groupFolder,
            isMain,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(tasksDir, data);

          return {
            content: [{
              type: 'text',
              text: `Handler ${args.handler_id} cancellation requested.`
            }]
          };
        }
      ),

      tool(
        'register_group',
        `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
        {
          jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
          name: z.string().describe('Display name for the group'),
          folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
          trigger: z.string().describe('Trigger word (e.g., "@Andy")')
        },
        async (args) => {
          if (!isMain) {
            return {
              content: [{ type: 'text', text: 'Only the main group can register new groups.' }],
              isError: true
            };
          }

          const data = {
            type: 'register_group',
            jid: args.jid,
            name: args.name,
            folder: args.folder,
            trigger: args.trigger,
            timestamp: new Date().toISOString()
          };

          writeIpcFile(tasksDir, data);

          return {
            content: [{
              type: 'text',
              text: `Group "${args.name}" registered. It will start receiving messages immediately.`
            }]
          };
        }
      )
    ]
  });
}
