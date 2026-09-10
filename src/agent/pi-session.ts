import path from 'node:path';

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentSession as PiSdkSession } from '@earendil-works/pi-coding-agent';

import { AGENT_TIMEOUT, AGENT_BACKEND, agentVarDir } from '../config.js';
import { resolveModelReference } from '../model-tiers.js';
import { emitEvent } from '../db.js';
import { logger } from '../logger.js';
import { ensureAgentVarLayout } from '../store/materialize.js';
import type { RegisteredAgent } from '../types.js';
import { stripPiPrefix } from './backend.js';
import { getPiModelRuntime } from './pi-runtime.js';
import { createPiTools } from './pi-tools.js';
import {
  DEFAULT_EFFORT,
  buildContextPrompt,
  buildWarmStartContext,
  type EffortLevel,
} from './runner.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import type {
  StreamingAgentSession,
  TurnCallbacks,
  TurnResult,
} from './session.js';

export interface PiSessionOptions {
  agent: RegisteredAgent;
  chatJid: string;
  model?: string;
  effort?: EffortLevel;
  isMain: boolean;
  imJids?: string[];
}

function parseModel(value: string): { provider: string; model: string } {
  const qualified = stripPiPrefix(value);
  const slash = qualified.indexOf('/');
  if (slash <= 0 || slash === qualified.length - 1) {
    throw new Error(
      'Pi models must be provider-qualified, for example pi:openai-codex/gpt-5.1-codex',
    );
  }
  return {
    provider: qualified.slice(0, slash),
    model: qualified.slice(slash + 1),
  };
}

function textFromMessages(session: PiSdkSession): string | null {
  for (const message of [...session.messages].reverse()) {
    if (message.role !== 'assistant') continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter(
        (part): part is { type: string; text?: string } =>
          typeof part === 'object' && part !== null && 'type' in part,
      )
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('');
    if (text) return text;
  }
  return null;
}

/**
 * Pi implementation of BearClaw's long-lived chat session contract. Pi owns
 * its in-memory turn queue; BearClaw remains the durable conversation record
 * and supplies warm-start context after a process restart.
 */
export class PiAgentSession implements StreamingAgentSession {
  private readonly agent: RegisteredAgent;
  private readonly chatJid: string;
  private readonly model: string;
  private readonly effort: EffortLevel;
  private readonly isMain: boolean;
  private readonly varDir: string;
  private readonly imJids: string[];
  private session: PiSdkSession | undefined;
  private closed = false;
  private draining = false;
  private lastInterruptedAt: number | null = null;
  private sentMediaViaIpc = false;

  constructor(opts: PiSessionOptions) {
    this.agent = opts.agent;
    this.chatJid = opts.chatJid;
    this.model = resolveModelReference(opts.model, AGENT_BACKEND) ?? '';
    this.effort = opts.effort ?? DEFAULT_EFFORT;
    this.isMain = opts.isMain;
    this.varDir = agentVarDir(opts.agent.folder);
    this.imJids = opts.imJids ?? [];
  }

  isClosed(): boolean {
    return this.closed;
  }
  isDraining(): boolean {
    return this.draining;
  }
  hasPendingTurns(): boolean {
    return Boolean(this.session && !this.session.isIdle);
  }
  getSessionId(): string | undefined {
    return this.session?.sessionId;
  }

  markDrain(): void {
    if (this.closed || this.draining) return;
    this.draining = true;
    if (!this.hasPendingTurns()) void this.close();
  }

  async start(): Promise<void> {
    if (this.session || this.closed) return;
    if (!this.model)
      throw new Error(
        'No model configured — finish setup at /setup or run bearclaw setup',
      );
    ensureAgentVarLayout(this.agent.folder);
    const runtime = await getPiModelRuntime();
    const parsed = parseModel(this.model);
    const model = runtime.getModel(parsed.provider, parsed.model);
    if (!model)
      throw new Error(`Pi model not found: ${parsed.provider}/${parsed.model}`);

    const warmStart = buildWarmStartContext(this.agent.folder, this.imJids);
    const context = [
      buildContextPrompt(this.agent.folder),
      SYSTEM_PROMPT,
      warmStart
        ? `Warm-start context (recent conversation history):\n\n${warmStart}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n---\n\n');
    const loader = new DefaultResourceLoader({
      cwd: this.varDir,
      agentDir: path.join(this.varDir, '.pi'),
      systemPromptOverride: () => context,
    });
    await loader.reload();
    const created = await createAgentSession({
      cwd: this.varDir,
      agentDir: path.join(this.varDir, '.pi'),
      modelRuntime: runtime,
      model,
      thinkingLevel: this.effort,
      resourceLoader: loader,
      // BearClaw owns durable history, session routing, and retention. Avoid
      // a second, hidden Pi transcript store until explicit Pi import/export.
      sessionManager: SessionManager.inMemory(this.varDir),
      // Pi has no Claude-style PreToolUse hook. Keep raw filesystem tools
      // read-only; BearClaw-owned tools enforce their mutation/shell policy.
      tools: [
        'read',
        'grep',
        'find',
        'ls',
        'send_message',
        'emit_event',
        'recall_history',
        'context_list',
        'context_read',
        'context_write',
        'subprocess_start',
        'subprocess_read',
        'subprocess_write',
        'subprocess_poll',
        'subprocess_kill',
        'subprocess_list',
        'workflow_list',
        'workflow_upsert',
        'workflow_delete',
        'workflow_run',
        'workflow_set_enabled',
        'workflow_runs',
        'workflow_waits',
        'workflow_respond',
        'run_cancel',
        'trigger_create',
        'trigger_list',
        'trigger_set_enabled',
        'trigger_delete',
        'image_generate',
      ],
      customTools: createPiTools({
        chatJid: this.chatJid,
        agentFolder: this.agent.folder,
        isMain: this.isMain,
        ipcDir: path.join(this.varDir, 'ipc'),
        onSendMessage: (info) => {
          this.sentMediaViaIpc ||= info.hasMedia;
        },
      }),
    });
    this.session = created.session;
  }

  async runTurn(prompt: string, callbacks: TurnCallbacks): Promise<TurnResult> {
    if (this.closed)
      return {
        status: 'error',
        result: null,
        error: 'Session is closed',
        sentMediaViaIpc: false,
      };
    if (this.draining)
      return {
        status: 'error',
        result: null,
        error: 'Session is draining',
        sentMediaViaIpc: false,
      };
    await this.start();
    this.sentMediaViaIpc = false;
    const session = this.session!;
    const startedAt = Date.now();
    let streamText = '';
    let error: string | undefined;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'message_update') {
        const update = (
          event as { assistantMessageEvent?: { type?: string; delta?: string } }
        ).assistantMessageEvent;
        if (update?.type === 'text_delta' && update.delta) {
          streamText += update.delta;
          callbacks.onText?.(streamText);
          callbacks.onActivity?.('Replying');
        }
      } else if (event.type === 'tool_execution_start') {
        const name = (event as { toolName?: string }).toolName ?? 'Tool';
        callbacks.onActivity?.(name);
      } else if (event.type === 'agent_end') {
        const state = session.state as { errorMessage?: string };
        error = state.errorMessage;
      }
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void session.abort();
    }, AGENT_TIMEOUT);
    try {
      await session.prompt(prompt);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
    const interrupted =
      this.lastInterruptedAt !== null &&
      Date.now() - this.lastInterruptedAt < 30_000;
    const result =
      error || timedOut || interrupted ? null : textFromMessages(session);
    emitEvent('agent_complete', {
      group_folder: this.agent.folder,
      trigger_type: 'message',
      status: result === null ? 'error' : 'success',
      duration_ms: Date.now() - startedAt,
    });
    return {
      status: result === null ? 'error' : 'success',
      result,
      error,
      timedOut,
      interrupted,
      sentMediaViaIpc: this.sentMediaViaIpc,
      newSessionId: session.sessionId,
    };
  }

  async setModel(_model: string): Promise<void> {
    logger.warn({ model: _model }, 'Pi model changes apply after /new');
  }

  async setEffort(_effort: EffortLevel): Promise<void> {
    logger.warn({ effort: _effort }, 'Pi effort changes apply after /new');
  }

  async interrupt(): Promise<boolean> {
    if (!this.session || this.session.isIdle) return false;
    this.lastInterruptedAt = Date.now();
    await this.session.abort();
    return true;
  }

  recentlyInterrupted(windowMs = 30_000): boolean {
    return (
      this.lastInterruptedAt !== null &&
      Date.now() - this.lastInterruptedAt < windowMs
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.session?.dispose();
  }
}
