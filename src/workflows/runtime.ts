import type { EffortLevel } from '../agent/runner.js';
import type { RunRow, WaitKind } from './db.js';
import type { EvalScope } from './expr.js';
import type { WorkflowDefinition, WorkflowNode } from './schema.js';

export interface AgentRunSpec {
  folder: string;
  chatJid: string;
  prompt: string;
  model?: string;
  effort?: EffortLevel;
  sessionId?: string;
  outputSchema?: unknown;
  allowedTools?: string[];
  maxTurns?: number;
  timeoutMs?: number;
  stepKey: string;
  signal: AbortSignal;
}

export interface AgentRunResult {
  status: 'success' | 'error';
  text: string | null;
  structured?: unknown;
  sessionId?: string;
  error?: string;
  timedOut?: boolean;
}

export interface ShellRunSpec {
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface ShellRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface SendSpec {
  folder: string;
  to?: string;
  text: string;
  media?: string[];
  // One-tap answers for channels that render them (Telegram inline keyboard).
  choices?: { label: string; data: string }[];
  stepKey: string;
}

export interface SendResult {
  targets: string[];
}

export interface MatchedEvent {
  id: number;
  type: string;
  payload: unknown;
  emitted_at: string;
}

// Everything the executors reach outside their own module. Injected so tests
// can drive the engine with fakes and no side effects.
export interface EngineDeps {
  runAgent(spec: AgentRunSpec): Promise<AgentRunResult>;
  runShell(spec: ShellRunSpec): Promise<ShellRunResult>;
  send(spec: SendSpec): Promise<SendResult>;
  emitEvent(type: string, payload: object): number;
  latestEventId(): number;
  findEvent(
    type: string,
    filter: Record<string, unknown> | null,
    opts: { afterId?: number; sinceIso?: string },
  ): MatchedEvent | null;
  readTemplateFile(file: string, folder: string): string;
  // A signed, single-use link for one action on one wait. Null when links are
  // unavailable (no auth secret yet).
  approvalLink(waitId: string, action: string, ttlMs: number): string | null;
  getChatSessionId(folder: string): string | undefined;
  setChatSessionId(folder: string, sessionId: string): void;
  now(): Date;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
}

export interface WaitSpec {
  kind: WaitKind;
  prompt?: string | null;
  options?: string[] | null;
  targets?: string[] | null;
  fields?: unknown;
  event_type?: string | null;
  filter?: Record<string, unknown> | null;
  event_floor?: number | null;
  resume_at?: string | null;
  on_timeout?: unknown;
}

export type ExecResult =
  | { kind: 'done'; output?: unknown; port?: string; sessionId?: string }
  | { kind: 'wait'; wait: WaitSpec }
  | { kind: 'fail'; message: string; retryable?: boolean };

export interface StepContext {
  run: RunRow;
  def: WorkflowDefinition;
  nodeId: string;
  node: WorkflowNode;
  attempt: number;
  stepKey: string;
  scope: EvalScope;
  signal: AbortSignal;
  deps: EngineDeps;
}

export type Executor = (ctx: StepContext) => Promise<ExecResult>;

export function stepKeyFor(
  runId: string,
  nodeId: string,
  attempt: number,
): string {
  return `${runId}:${nodeId}:${attempt}`;
}

export function fail(message: string, retryable = false): ExecResult {
  return { kind: 'fail', message, retryable };
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
