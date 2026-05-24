/**
 * Persistent per-agent SDK session using streaming-input mode.
 *
 * One long-lived `query()` per agent folder. User messages are pushed into
 * an AsyncIterable; the SDK processes them as turns. Each turn ends when a
 * `result` SDKMessage is observed; the corresponding pending Promise resolves.
 *
 * Phase 1 scope: queue-and-wait. No interrupt-on-new-message yet (phase 2).
 * Mid-session model/effort changes are NOT supported — they take effect after
 * a /new (which closes and recreates this session).
 */
import fs from 'fs';
import path from 'path';
import {
  query,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import {
  AGENT_TIMEOUT,
  RUN_DIR,
  agentDir as agentPersistentDir,
  agentVarDir,
} from '../config.js';
import { logger } from '../logger.js';
import { RegisteredAgent } from '../types.js';
import { createIpcMcp } from './ipc-mcp.js';
import { loadUserMcpServers } from './mcp-config.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EffortLevel,
  buildContextPrompt,
  createSessionStartHook,
  describeBlock,
} from './runner.js';
import { emitEvent } from '../db.js';

export interface TurnCallbacks {
  onText?: (text: string) => void;
  onActivity?: (label: string) => void;
}

export interface TurnResult {
  status: 'success' | 'error';
  result: string | null;
  error?: string;
  timedOut?: boolean;
  interrupted?: boolean;
  sentMediaViaIpc: boolean;
  newSessionId?: string;
}

interface PendingTurn {
  resolve: (r: TurnResult) => void;
  callbacks: TurnCallbacks;
  streamText: string;
  startedAt: number;
  sentMediaViaIpc: boolean;
  timeoutHandle: ReturnType<typeof setTimeout>;
  timedOut: boolean;
  interrupted: boolean;
}

class InputController {
  private waiter: ((value: IteratorResult<SDKUserMessage>) => void) | null =
    null;
  private buffer: SDKUserMessage[] = [];
  private done = false;

  push(msg: SDKUserMessage): void {
    if (this.done) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: msg, done: false });
    } else {
      this.buffer.push(msg);
    }
  }

  end(): void {
    this.done = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  }

  iterable(): AsyncIterable<SDKUserMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            if (self.buffer.length > 0) {
              const value = self.buffer.shift() as SDKUserMessage;
              return Promise.resolve({ value, done: false });
            }
            if (self.done) {
              return Promise.resolve({
                value: undefined as unknown as SDKUserMessage,
                done: true,
              });
            }
            return new Promise((resolve) => {
              self.waiter = resolve;
            });
          },
          return(): Promise<IteratorResult<SDKUserMessage>> {
            self.end();
            return Promise.resolve({
              value: undefined as unknown as SDKUserMessage,
              done: true,
            });
          },
        };
      },
    };
  }
}

export interface SessionOptions {
  agent: RegisteredAgent;
  chatJid: string;
  resumeSessionId?: string;
  model?: string;
  effort?: EffortLevel;
  isMain: boolean;
  imJids?: string[];
}

export class AgentSession {
  private readonly agent: RegisteredAgent;
  private readonly chatJid: string;
  private readonly isMain: boolean;
  private readonly model: string;
  private readonly effort: EffortLevel;
  private readonly varDir: string;
  private readonly imJids: string[];
  private input = new InputController();
  private query: Query | null = null;
  private turnQueue: PendingTurn[] = [];
  private sessionId: string | undefined;
  private closed = false;
  private consumerError: Error | null = null;
  private lastInterruptedAt: number | null = null;

  constructor(opts: SessionOptions) {
    this.agent = opts.agent;
    this.chatJid = opts.chatJid;
    this.isMain = opts.isMain;
    this.sessionId = opts.resumeSessionId;
    this.model = opts.model || DEFAULT_MODEL;
    this.effort = opts.effort || DEFAULT_EFFORT;
    this.varDir = agentVarDir(this.agent.folder);
    this.imJids = opts.imJids ?? [];
  }

  isClosed(): boolean {
    return this.closed;
  }

  hasPendingTurns(): boolean {
    return this.turnQueue.length > 0;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  start(): void {
    if (this.query || this.closed) return;

    const persistentDir = agentPersistentDir(this.agent.folder);
    fs.mkdirSync(persistentDir, { recursive: true });
    fs.mkdirSync(this.varDir, { recursive: true });

    const agentIpcDir = path.join(RUN_DIR, 'ipc', this.agent.folder);
    fs.mkdirSync(path.join(agentIpcDir, 'messages'), { recursive: true });
    fs.mkdirSync(path.join(agentIpcDir, 'tasks'), { recursive: true });

    const ipcMcp = createIpcMcp({
      chatJid: this.chatJid,
      agentFolder: this.agent.folder,
      isMain: this.isMain,
      ipcDir: agentIpcDir,
      onSendMessage: ({ hasMedia }) => {
        const head = this.turnQueue[0];
        if (head && hasMedia) head.sentMediaViaIpc = true;
      },
    });

    const userMcpServers = loadUserMcpServers();

    const contextPrompt = buildContextPrompt(this.agent.folder);
    const fullSystemPrompt = [contextPrompt, SYSTEM_PROMPT]
      .filter(Boolean)
      .join('\n\n---\n\n');

    logger.info(
      {
        group: this.agent.name,
        isMain: this.isMain,
        resume: this.sessionId,
        model: this.model,
        effort: this.effort,
      },
      'Streaming-input session starting',
    );

    this.query = query({
      prompt: this.input.iterable(),
      options: {
        cwd: this.varDir,
        resume: this.sessionId,
        model: this.model,
        effort: this.effort,
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
        includePartialMessages: true,
        mcpServers: {
          nanoclaw: ipcMcp,
          ...userMcpServers,
        },
        hooks: {
          SessionStart: [
            {
              hooks: [createSessionStartHook(this.agent.folder, this.imJids)],
            },
          ],
        },
      },
    });

    void this.consume();
  }

  async runTurn(
    promptText: string,
    callbacks: TurnCallbacks,
  ): Promise<TurnResult> {
    if (this.closed) {
      return {
        status: 'error',
        result: null,
        error: 'Session is closed',
        sentMediaViaIpc: false,
      };
    }
    if (!this.query) this.start();

    return new Promise<TurnResult>((resolve) => {
      const turn: PendingTurn = {
        resolve,
        callbacks,
        streamText: '',
        startedAt: Date.now(),
        sentMediaViaIpc: false,
        timedOut: false,
        interrupted: false,
        timeoutHandle: setTimeout(() => {
          turn.timedOut = true;
          logger.error(
            { group: this.agent.name },
            `Turn timeout after ${AGENT_TIMEOUT}ms, interrupting`,
          );
          void this.query?.interrupt().catch((err) => {
            logger.warn(
              { err, group: this.agent.name },
              'interrupt() failed on timeout',
            );
          });
        }, AGENT_TIMEOUT),
      };
      this.turnQueue.push(turn);

      // Note: per-turn keyword bumps (ultrathink, etc.) and /model, /effort
      // changes do not apply mid-session in phase 1. Effort and model are
      // frozen at Query creation time; /new clears the session.

      const sdkMsg: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: promptText },
        parent_tool_use_id: null,
      };
      this.input.push(sdkMsg);
    });
  }

  async setModel(model: string): Promise<void> {
    if (this.closed || !this.query) return;
    try {
      await this.query.setModel(model);
      logger.info(
        { group: this.agent.name, model },
        'AgentSession.setModel applied',
      );
    } catch (err) {
      logger.warn(
        { err, group: this.agent.name, model },
        'AgentSession.setModel failed',
      );
    }
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    if (this.closed || !this.query) return;
    try {
      await this.query.applyFlagSettings({ effort });
      logger.info(
        { group: this.agent.name, effort },
        'AgentSession.setEffort applied',
      );
    } catch (err) {
      logger.warn(
        { err, group: this.agent.name, effort },
        'AgentSession.setEffort failed',
      );
    }
  }

  async interrupt(): Promise<boolean> {
    if (!this.query) return false;
    const head = this.turnQueue[0];
    if (!head) return false;
    head.interrupted = true;
    this.lastInterruptedAt = Date.now();
    try {
      await this.query.interrupt();
      logger.info({ group: this.agent.name }, 'AgentSession.interrupt invoked');
      return true;
    } catch (err) {
      logger.warn(
        { err, group: this.agent.name },
        'AgentSession.interrupt failed',
      );
      return false;
    }
  }

  // True if interrupt() fired in the recent window. Lets callers report
  // "interrupted" even if the SDK already finished tearing down by the
  // time the slash command runs.
  recentlyInterrupted(windowMs = 30_000): boolean {
    if (this.lastInterruptedAt === null) return false;
    return Date.now() - this.lastInterruptedAt < windowMs;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.input.end();
    if (this.query) {
      try {
        this.query.close();
      } catch (err) {
        logger.warn({ err, group: this.agent.name }, 'Query.close() raised');
      }
    }
    // Reject any still-pending turns
    while (this.turnQueue.length > 0) {
      const t = this.turnQueue.shift()!;
      clearTimeout(t.timeoutHandle);
      t.resolve({
        status: 'error',
        result: null,
        error: 'Session closed',
        sentMediaViaIpc: t.sentMediaViaIpc,
        interrupted: t.interrupted,
      });
    }
  }

  private async consume(): Promise<void> {
    if (!this.query) return;
    try {
      for await (const msg of this.query) {
        this.handleMessage(msg);
      }
    } catch (err) {
      this.consumerError = err instanceof Error ? err : new Error(String(err));
      logger.error(
        { err, group: this.agent.name },
        'Streaming-input consumer crashed',
      );
    } finally {
      // Drain any pending turns with whatever error we have.
      const errMsg =
        this.consumerError?.message || 'Session ended unexpectedly';
      while (this.turnQueue.length > 0) {
        const t = this.turnQueue.shift()!;
        clearTimeout(t.timeoutHandle);
        t.resolve({
          status: 'error',
          result: null,
          error: errMsg,
          sentMediaViaIpc: t.sentMediaViaIpc,
          timedOut: t.timedOut,
          interrupted: t.interrupted,
        });
      }
      this.closed = true;
    }
  }

  private handleMessage(msg: SDKMessage): void {
    const head = this.turnQueue[0];

    if (
      msg.type === 'system' &&
      (msg as { subtype?: string }).subtype === 'init'
    ) {
      const sid = (msg as { session_id?: string }).session_id;
      if (sid) this.sessionId = sid;
    }

    if (head && msg.type === 'stream_event' && head.callbacks.onText) {
      const event = (
        msg as {
          event?: { type?: string; delta?: { type?: string; text?: string } };
        }
      ).event;
      if (event?.type === 'message_start') {
        head.streamText = '';
      } else if (
        event?.type === 'content_block_delta' &&
        event?.delta?.type === 'text_delta'
      ) {
        const firstDelta = head.streamText === '';
        head.streamText += event.delta.text || '';
        if (head.streamText.trim()) head.callbacks.onText(head.streamText);
        // Bump activity to "Replying" the moment text generation starts, so
        // progress-mode indicators don't stay stuck on "Thinking" while the
        // model is actually emitting the reply.
        if (firstDelta && head.callbacks.onActivity) {
          head.callbacks.onActivity('Replying');
        }
      }
    }

    if (head && msg.type === 'assistant' && head.callbacks.onActivity) {
      const blocks = (msg as { message?: { content?: unknown } })?.message
        ?.content;
      if (Array.isArray(blocks)) {
        let label: string | null = null;
        for (const b of blocks) {
          const l = describeBlock(b as { type?: string });
          if (l) label = l;
        }
        if (label) head.callbacks.onActivity(label);
      }
    }

    if (msg.type === 'result') {
      const turn = this.turnQueue.shift();
      if (!turn) return;
      clearTimeout(turn.timeoutHandle);

      const subtype = (msg as { subtype?: string }).subtype;
      const isSuccess = subtype === 'success';
      const result =
        isSuccess && 'result' in msg
          ? ((msg as { result?: string }).result ?? null)
          : null;

      const duration = Date.now() - turn.startedAt;
      logger.info(
        {
          group: this.agent.name,
          duration,
          status: isSuccess ? 'success' : 'error',
          subtype,
          hasResult: !!result,
        },
        'Streaming-input turn complete',
      );

      emitEvent('agent_complete', {
        group_folder: this.agent.folder,
        trigger_type: 'message',
        status: isSuccess ? 'success' : 'error',
        duration_ms: duration,
      });

      turn.resolve({
        status: isSuccess ? 'success' : 'error',
        result,
        sentMediaViaIpc: turn.sentMediaViaIpc,
        timedOut: turn.timedOut,
        interrupted: turn.interrupted,
        newSessionId: this.sessionId,
      });
    }
  }
}
