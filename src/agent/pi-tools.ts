import fs from 'node:fs';
import path from 'node:path';

import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { GOOGLE_API_KEY, OPENAI_API_KEY, agentVarDir } from '../config.js';
import { emitEvent } from '../db.js';
import { logger } from '../logger.js';
import { cacheDir } from '../store/paths.js';
import {
  getRun,
  getWorkflowRow,
  listOpenWaits,
  listRuns,
  listSteps,
  listWorkflowRows,
  setWorkflowEnabled,
} from '../workflows/db.js';
import { cancelRun, resolveWait } from '../workflows/engine.js';
import { deleteWorkflow, saveWorkflowDefinition } from '../workflows/store.js';
import {
  createTrigger,
  deleteTrigger,
  listTriggers,
  runManually,
  setTriggerEnabled,
} from '../workflows/triggers.js';
import {
  contextList,
  contextRead,
  contextWrite,
  type ContextToolCtx,
} from './context-tools.js';
import { generateImage } from './image-gen.js';
import { queryRecall, syncRecallIndex } from './recall-index.js';
import {
  killSubprocess,
  listSubprocesses,
  pollSubprocess,
  readSubprocessOutput,
  startSubprocess,
  writeSubprocessInput,
} from './subprocess-manager.js';

export interface PiToolContext {
  chatJid: string;
  agentFolder: string;
  isMain: boolean;
  ipcDir: string;
  onSendMessage?: (info: { hasMedia: boolean }) => void;
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, never>;
  isError?: boolean;
};

function result(text: string, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text }],
    details: {},
    ...(isError ? { isError } : {}),
  };
}

function fromError(error: unknown): ToolResult {
  return result(error instanceof Error ? error.message : String(error), true);
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const destination = path.join(dir, filename);
  const temporary = `${destination}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, destination);
  return filename;
}

// Pi has no Claude-style PreToolUse hook. It intentionally does not expose
// Pi's raw bash/write/edit tools; this guard protects the one shell-capable
// BearClaw host tool as well.
function assertSafeSubprocess(command: string): void {
  const cache = cacheDir();
  if (command.includes(cache) || /(?:^|[\s"'])context\//.test(command)) {
    throw new Error(
      'Commands may not write BearClaw context or cache mirrors. Use context_write for context changes.',
    );
  }
}

function assertWorkflowOwnership(ctx: PiToolContext, owner: string): void {
  if (!ctx.isMain && owner !== ctx.agentFolder) {
    throw new Error(
      `Workflow is owned by "${owner}". You can only manage your own workflows.`,
    );
  }
}

export function createPiTools(ctx: PiToolContext) {
  const messagesDir = path.join(ctx.ipcDir, 'messages');
  const toolCtx: ContextToolCtx = {
    agentFolder: ctx.agentFolder,
    isMain: ctx.isMain,
  };

  const sendMessage = defineTool({
    name: 'send_message',
    label: 'Send message',
    description:
      'Send media, an early acknowledgement, or a scheduled-task result. Normal final text is delivered automatically, so do not use this for ordinary replies.',
    parameters: Type.Object({
      text: Type.Optional(Type.String()),
      sender: Type.Optional(Type.String()),
      media_type: Type.Optional(
        Type.Union([
          Type.Literal('image'),
          Type.Literal('document'),
          Type.Literal('video'),
          Type.Literal('audio'),
        ]),
      ),
      file_path: Type.Optional(Type.String()),
      media_url: Type.Optional(Type.String()),
      file_name: Type.Optional(Type.String()),
      mimetype: Type.Optional(Type.String()),
      ptt: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, args) {
      if (!args.text && !args.media_type)
        return result('Provide text or media_type.', true);
      if (args.media_type && !args.file_path && !args.media_url)
        return result('media_type requires file_path or media_url.', true);
      const filename = writeIpcFile(messagesDir, {
        type: 'message',
        chatJid: ctx.chatJid,
        text: args.text || null,
        sender: args.sender,
        agentFolder: ctx.agentFolder,
        timestamp: new Date().toISOString(),
        ...(args.media_type
          ? {
              mediaType: args.media_type,
              filePath: args.file_path || null,
              mediaUrl: args.media_url || null,
              fileName: args.file_name || null,
              mimetype: args.mimetype || null,
              ptt: args.ptt || false,
            }
          : {}),
      });
      ctx.onSendMessage?.({ hasMedia: Boolean(args.media_type) });
      return result(`Message queued for delivery (${filename}).`);
    },
  });

  const emitEventTool = defineTool({
    name: 'emit_event',
    label: 'Emit event',
    description:
      'Emit an event that can trigger a BearClaw workflow. Non-main agents may only emit event names prefixed with their own folder.',
    parameters: Type.Object({
      type: Type.String(),
      payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(_id, args) {
      if (!ctx.isMain && !args.type.startsWith(`${ctx.agentFolder}.`))
        return result(
          `Not allowed: event names must begin ${ctx.agentFolder}.`,
          true,
        );
      const id = emitEvent(args.type, {
        ...(args.payload ?? {}),
        emitted_by: ctx.agentFolder,
      });
      return result(`Event "${args.type}" emitted (id ${id}).`);
    },
  });

  const recallHistory = defineTool({
    name: 'recall_history',
    label: 'Recall history',
    description:
      'Search this agent’s archived conversations and recovery checkpoints. Supports FTS5 syntax such as quoted phrases and uppercase OR.',
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_id, args) {
      try {
        const stats = syncRecallIndex(ctx.agentFolder);
        const hits = queryRecall(ctx.agentFolder, args.query, args.limit ?? 20);
        if (!hits.length)
          return result(
            `No matches for ${JSON.stringify(args.query)}. Indexed ${stats.scanned} files (${stats.reindexed} reindexed).`,
          );
        return result(
          hits
            .map(
              (hit) =>
                `=== ${hit.source}/${hit.filename}:${hit.lineStart}-${hit.lineEnd} (bm25=${hit.score.toFixed(2)}) ===\n${hit.text}`,
            )
            .join('\n\n'),
        );
      } catch (error) {
        return fromError(error);
      }
    },
  });

  const contextListTool = defineTool({
    name: 'context_list',
    label: 'List context',
    description: 'List BearClaw’s shared and agent context documents.',
    parameters: Type.Object({}),
    async execute() {
      return result(contextList(toolCtx));
    },
  });
  const contextReadTool = defineTool({
    name: 'context_read',
    label: 'Read context',
    description: 'Read a current context document from the BearClaw store.',
    parameters: Type.Object({
      scope: Type.Union([Type.Literal('shared'), Type.Literal('agent')]),
      name: Type.String(),
      folder: Type.Optional(Type.String()),
    }),
    async execute(_id, args) {
      try {
        return result(contextRead(toolCtx, args));
      } catch (error) {
        return fromError(error);
      }
    },
  });
  const contextWriteTool = defineTool({
    name: 'context_write',
    label: 'Write context',
    description:
      'Write BearClaw context. This is the only supported way to change context; cache mirrors are read-only.',
    parameters: Type.Object({
      scope: Type.Union([Type.Literal('shared'), Type.Literal('agent')]),
      name: Type.String(),
      content: Type.String(),
      folder: Type.Optional(Type.String()),
      mode: Type.Optional(
        Type.Union([Type.Literal('append'), Type.Literal('replace')]),
      ),
    }),
    async execute(_id, args) {
      try {
        return result(contextWrite(toolCtx, args));
      } catch (error) {
        return fromError(error);
      }
    },
  });

  const subprocessStart = defineTool({
    name: 'subprocess_start',
    label: 'Start subprocess',
    description:
      'Start a managed PTY subprocess. It cannot write BearClaw context/cache mirrors.',
    parameters: Type.Object({
      name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      command: Type.String(),
      workdir: Type.Optional(Type.String()),
      cols: Type.Optional(Type.Number()),
      rows: Type.Optional(Type.Number()),
      on_exit: Type.Optional(Type.String()),
      on_notification: Type.Optional(Type.String()),
      prompt_suffix: Type.Optional(Type.String()),
    }),
    async execute(_id, args) {
      try {
        assertSafeSubprocess(args.command);
        const sessionId = startSubprocess({
          name: args.name,
          description: args.description,
          command: args.command,
          workdir: args.workdir,
          agentFolder: ctx.agentFolder,
          chatJid: ctx.chatJid,
          cols: args.cols ?? 220,
          rows: args.rows ?? 50,
          on_exit: args.on_exit,
          on_notification: args.on_notification,
          prompt_suffix: args.prompt_suffix,
        });
        return result(JSON.stringify({ sessionId }));
      } catch (error) {
        return fromError(error);
      }
    },
  });
  const subprocessRead = defineTool({
    name: 'subprocess_read',
    label: 'Read subprocess',
    description: 'Read buffered subprocess output.',
    parameters: Type.Object({
      session_id: Type.String(),
      offset: Type.Optional(Type.Number()),
    }),
    async execute(_id, args) {
      return result(
        JSON.stringify(readSubprocessOutput(args.session_id, args.offset ?? 0)),
      );
    },
  });
  const subprocessWrite = defineTool({
    name: 'subprocess_write',
    label: 'Write subprocess',
    description: 'Write stdin to a managed subprocess.',
    parameters: Type.Object({ session_id: Type.String(), data: Type.String() }),
    async execute(_id, args) {
      const ok = writeSubprocessInput(args.session_id, args.data);
      return result(
        ok ? 'Written.' : 'Subprocess not found or not running.',
        !ok,
      );
    },
  });
  const subprocessPoll = defineTool({
    name: 'subprocess_poll',
    label: 'Poll subprocess',
    description: 'Check a managed subprocess.',
    parameters: Type.Object({ session_id: Type.String() }),
    async execute(_id, args) {
      const state = pollSubprocess(args.session_id);
      return state
        ? result(JSON.stringify(state))
        : result('Session not found.', true);
    },
  });
  const subprocessKill = defineTool({
    name: 'subprocess_kill',
    label: 'Stop subprocess',
    description: 'Terminate a managed subprocess.',
    parameters: Type.Object({ session_id: Type.String() }),
    async execute(_id, args) {
      const ok = killSubprocess(args.session_id);
      return result(
        ok ? 'Process killed.' : 'Subprocess not found or already exited.',
        !ok,
      );
    },
  });
  const subprocessList = defineTool({
    name: 'subprocess_list',
    label: 'List subprocesses',
    description: 'List managed subprocess sessions.',
    parameters: Type.Object({}),
    async execute() {
      return result(JSON.stringify(listSubprocesses()));
    },
  });

  const workflowList = defineTool({
    name: 'workflow_list',
    label: 'List workflows',
    description: 'List BearClaw workflows and status.',
    parameters: Type.Object({
      slug: Type.Optional(Type.String()),
      tag: Type.Optional(Type.String()),
    }),
    async execute(_id, args) {
      const tag = args.tag?.trim().toLowerCase();
      const rows = listWorkflowRows().filter(
        (row) =>
          (!args.slug || row.slug === args.slug) &&
          (!tag || (row.definition.tags ?? []).includes(tag)),
      );
      return result(
        rows.length
          ? rows
              .map(
                (row) =>
                  `${row.slug} — ${row.name} [owner ${row.owner}${row.enabled ? '' : ', disabled'}]\n  triggers: ${
                    listTriggers(row.slug)
                      .map(
                        (trigger) =>
                          `${trigger.type}${trigger.enabled ? '' : ' (paused)'}`,
                      )
                      .join(', ') || 'none'
                  }\n  last: ${row.last_status ?? 'never run'}`,
              )
              .join('\n\n')
          : 'No workflows.',
      );
    },
  });
  const workflowUpsert = defineTool({
    name: 'workflow_upsert',
    label: 'Save workflow',
    description:
      'Create or replace a workflow. Supply the complete workflow definition object.',
    parameters: Type.Object({
      definition: Type.Record(Type.String(), Type.Unknown()),
    }),
    async execute(_id, args) {
      try {
        const owner = String(
          (args.definition as { owner?: unknown }).owner ?? ctx.agentFolder,
        );
        assertWorkflowOwnership(ctx, owner);
        const definition = saveWorkflowDefinition({
          ...args.definition,
          owner,
        } as never);
        return result(
          `Workflow "${definition.slug}" saved with ${Object.keys(definition.nodes).length} nodes.`,
        );
      } catch (error) {
        return fromError(error);
      }
    },
  });
  const workflowDelete = defineTool({
    name: 'workflow_delete',
    label: 'Delete workflow',
    description: 'Delete a workflow definition.',
    parameters: Type.Object({ slug: Type.String() }),
    async execute(_id, args) {
      try {
        const row = getWorkflowRow(args.slug);
        if (!row) throw new Error(`Unknown workflow: ${args.slug}`);
        assertWorkflowOwnership(ctx, row.owner);
        deleteWorkflow(args.slug);
        return result(`Workflow "${args.slug}" deleted.`);
      } catch (error) {
        return fromError(error);
      }
    },
  });
  const workflowRun = defineTool({
    name: 'workflow_run',
    label: 'Run workflow',
    description: 'Start a workflow run now.',
    parameters: Type.Object({
      slug: Type.String(),
      inputs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(_id, args) {
      try {
        const row = getWorkflowRow(args.slug);
        if (!row) throw new Error(`Unknown workflow: ${args.slug}`);
        assertWorkflowOwnership(ctx, row.owner);
        const started = await runManually(
          args.slug,
          args.inputs ?? {},
          ctx.agentFolder,
        );
        if (!started.runId) return result(`Run ${started.status}.`);
        const run = getRun(started.runId);
        return result(
          `Run ${started.runId} is ${run?.status}. Steps: ${
            listSteps(started.runId)
              .map((step) => `${step.node_id}=${step.status}`)
              .join(', ') || 'none'
          }${run?.error ? `\nError: ${run.error}` : ''}`,
        );
      } catch (error) {
        return fromError(error);
      }
    },
  });
  const workflowSetEnabled = defineTool({
    name: 'workflow_set_enabled',
    label: 'Enable workflow',
    description: 'Pause or resume a workflow.',
    parameters: Type.Object({ slug: Type.String(), enabled: Type.Boolean() }),
    async execute(_id, args) {
      try {
        const row = getWorkflowRow(args.slug);
        if (!row) throw new Error(`Unknown workflow: ${args.slug}`);
        assertWorkflowOwnership(ctx, row.owner);
        setWorkflowEnabled(args.slug, args.enabled);
        return result(
          `Workflow "${args.slug}" ${args.enabled ? 'enabled' : 'paused'}.`,
        );
      } catch (error) {
        return fromError(error);
      }
    },
  });
  const workflowRuns = defineTool({
    name: 'workflow_runs',
    label: 'List workflow runs',
    description: 'List recent workflow runs.',
    parameters: Type.Object({
      slug: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    async execute(_id, args) {
      const runs = listRuns(args.slug, args.limit ?? 10);
      return result(
        runs.length
          ? runs
              .map(
                (run) =>
                  `${run.id} ${run.slug} ${run.status} started ${run.started_at}${run.error ? ` — ${run.error}` : ''}`,
              )
              .join('\n')
          : 'No runs.',
      );
    },
  });
  const workflowWaits = defineTool({
    name: 'workflow_waits',
    label: 'List workflow waits',
    description: 'List open human workflow steps.',
    parameters: Type.Object({}),
    async execute() {
      const waits = listOpenWaits('human');
      return result(
        waits.length
          ? waits
              .map(
                (wait) =>
                  `${wait.id} · ${getRun(wait.run_id)?.slug ?? '?'} / ${wait.node_id}\n  ${wait.prompt ?? ''}`,
              )
              .join('\n\n')
          : 'Nothing is waiting on a human.',
      );
    },
  });
  const workflowRespond = defineTool({
    name: 'workflow_respond',
    label: 'Respond to workflow',
    description: 'Resolve an open human workflow step.',
    parameters: Type.Object({
      wait_id: Type.String(),
      response: Type.Unknown(),
    }),
    async execute(_id, args) {
      try {
        await resolveWait(
          args.wait_id,
          args.response,
          ctx.chatJid || ctx.agentFolder,
          'agent',
        );
        return result(`Wait ${args.wait_id} resolved.`);
      } catch (error) {
        return fromError(error);
      }
    },
  });
  const runCancel = defineTool({
    name: 'run_cancel',
    label: 'Cancel workflow run',
    description: 'Cancel a running or waiting workflow.',
    parameters: Type.Object({
      run_id: Type.String(),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id, args) {
      try {
        const run = getRun(args.run_id);
        if (!run) throw new Error(`Unknown run: ${args.run_id}`);
        const row = getWorkflowRow(run.slug);
        if (row) assertWorkflowOwnership(ctx, row.owner);
        await cancelRun(args.run_id, args.reason ?? 'cancelled by agent');
        return result(`Run ${args.run_id} cancelled.`);
      } catch (error) {
        return fromError(error);
      }
    },
  });
  const triggerCreate = defineTool({
    name: 'trigger_create',
    label: 'Create trigger',
    description:
      'Create a cron, at, event, manual, or webhook workflow trigger.',
    parameters: Type.Object({
      slug: Type.String(),
      type: Type.Union([
        Type.Literal('cron'),
        Type.Literal('event'),
        Type.Literal('manual'),
        Type.Literal('webhook'),
        Type.Literal('at'),
      ]),
      config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(_id, args) {
      try {
        const row = getWorkflowRow(args.slug);
        if (!row) throw new Error(`Unknown workflow: ${args.slug}`);
        assertWorkflowOwnership(ctx, row.owner);
        const trigger = createTrigger({
          slug: args.slug,
          type: args.type,
          config: args.config ?? {},
          args: args.args ?? {},
          createdBy: ctx.agentFolder,
        });
        return result(
          `Trigger ${trigger.id} created (${trigger.type})${trigger.next_run_at ? `, next fire ${trigger.next_run_at}` : ''}`,
        );
      } catch (error) {
        return fromError(error);
      }
    },
  });
  const triggerList = defineTool({
    name: 'trigger_list',
    label: 'List triggers',
    description: 'List workflow triggers.',
    parameters: Type.Object({ slug: Type.Optional(Type.String()) }),
    async execute(_id, args) {
      const triggers = listTriggers(args.slug);
      return result(
        triggers.length
          ? triggers
              .map(
                (trigger) =>
                  `${trigger.id} · ${trigger.slug} · ${trigger.type}${trigger.enabled ? '' : ' · paused'}${trigger.next_run_at ? ` · next ${trigger.next_run_at}` : ''}`,
              )
              .join('\n')
          : 'No triggers.',
      );
    },
  });
  const triggerSetEnabled = defineTool({
    name: 'trigger_set_enabled',
    label: 'Enable trigger',
    description: 'Pause or resume a workflow trigger.',
    parameters: Type.Object({ id: Type.String(), enabled: Type.Boolean() }),
    async execute(_id, args) {
      try {
        setTriggerEnabled(args.id, args.enabled);
        return result(
          `Trigger ${args.id} ${args.enabled ? 'enabled' : 'paused'}.`,
        );
      } catch (error) {
        return fromError(error);
      }
    },
  });
  const triggerDelete = defineTool({
    name: 'trigger_delete',
    label: 'Delete trigger',
    description: 'Delete a runtime workflow trigger.',
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, args) {
      try {
        deleteTrigger(args.id);
        return result(`Trigger ${args.id} deleted.`);
      } catch (error) {
        return fromError(error);
      }
    },
  });

  const tools = [
    sendMessage,
    emitEventTool,
    recallHistory,
    contextListTool,
    contextReadTool,
    contextWriteTool,
    subprocessStart,
    subprocessRead,
    subprocessWrite,
    subprocessPoll,
    subprocessKill,
    subprocessList,
    workflowList,
    workflowUpsert,
    workflowDelete,
    workflowRun,
    workflowSetEnabled,
    workflowRuns,
    workflowWaits,
    workflowRespond,
    runCancel,
    triggerCreate,
    triggerList,
    triggerSetEnabled,
    triggerDelete,
  ];
  if (!OPENAI_API_KEY && !GOOGLE_API_KEY) return tools;
  tools.push(
    defineTool({
      name: 'image_generate',
      label: 'Generate image',
      description:
        'Generate an image. Set wait=true to receive the file path; otherwise it is sent to the chat when ready.',
      parameters: Type.Object({
        prompt: Type.String(),
        caption: Type.Optional(Type.String()),
        wait: Type.Optional(Type.Boolean()),
        model: Type.Optional(Type.String()),
        size: Type.Optional(
          Type.Union([
            Type.Literal('1024x1024'),
            Type.Literal('1024x1536'),
            Type.Literal('1536x1024'),
            Type.Literal('auto'),
          ]),
        ),
        quality: Type.Optional(
          Type.Union([
            Type.Literal('low'),
            Type.Literal('medium'),
            Type.Literal('high'),
            Type.Literal('auto'),
          ]),
        ),
        background: Type.Optional(
          Type.Union([
            Type.Literal('transparent'),
            Type.Literal('opaque'),
            Type.Literal('auto'),
          ]),
        ),
        output_format: Type.Optional(
          Type.Union([
            Type.Literal('png'),
            Type.Literal('jpeg'),
            Type.Literal('webp'),
          ]),
        ),
        input_images: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id, args) {
        const requestedModel =
          args.model || (OPENAI_API_KEY ? 'gpt-image-2' : 'nano-banana');
        const callArgs = {
          prompt: args.prompt,
          model: requestedModel,
          size: args.size,
          quality: args.quality,
          background: args.background,
          outputFormat: args.output_format,
          outputDir: path.join(agentVarDir(ctx.agentFolder), 'media'),
          inputImages: args.input_images,
          baseDir: agentVarDir(ctx.agentFolder),
        };
        if (args.wait) {
          try {
            const filepath = await generateImage(callArgs);
            return result(`Image generated at: ${filepath}`);
          } catch (error) {
            return fromError(error);
          }
        }
        void generateImage(callArgs)
          .then((filepath) =>
            writeIpcFile(messagesDir, {
              type: 'message',
              chatJid: ctx.chatJid,
              text: args.caption || null,
              agentFolder: ctx.agentFolder,
              timestamp: new Date().toISOString(),
              mediaType: 'image',
              filePath: filepath,
              mediaUrl: null,
              fileName: null,
              mimetype: `image/${args.output_format || 'png'}`,
              ptt: false,
            }),
          )
          .catch((error: unknown) => {
            logger.warn({ error }, 'Pi image generation failed');
            writeIpcFile(messagesDir, {
              type: 'message',
              chatJid: ctx.chatJid,
              text: `Image generation failed: ${error instanceof Error ? error.message : String(error)}`,
              agentFolder: ctx.agentFolder,
              timestamp: new Date().toISOString(),
            });
          });
        return result(
          `Image generation queued (${requestedModel}). It will be delivered automatically.`,
        );
      },
    }),
  );
  return tools;
}
