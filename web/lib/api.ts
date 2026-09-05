// Client + server helpers for talking to the in-process Node HTTP API.
// All paths go through Next's rewrite to the backend (default 127.0.0.1:7878).

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  installed: boolean;
  source: string;
}

export interface SkillSource {
  dir: string;
  label: string;
  builtin: boolean;
}

export interface SkillFileInfo {
  relpath: string;
  mode: number;
  size: number;
  updatedAt: string;
}

export interface SkillFileContent {
  name: string;
  path: string;
  mode: number;
  size: number;
  updatedAt: string;
  binary: boolean;
  content: string;
}

export interface EventRecord {
  id: number;
  type: string;
  payload: string;
  emitted_at: string;
  processed: number;
}

// ─── Workflows ──────────────────────────────────────────────────────────────

export interface WorkflowTrigger {
  id: string;
  slug: string;
  type: 'cron' | 'event' | 'manual' | 'webhook' | 'at';
  source: 'file' | 'runtime';
  config: Record<string, unknown>;
  args: Record<string, unknown>;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunId: string | null;
  lastFiredAt: string | null;
  createdBy: string | null;
}

export interface WorkflowSummary {
  slug: string;
  name: string;
  owner: string;
  enabled: boolean;
  description: string | null;
  tags: string[];
  nodeCount: number;
  lastStatus: string | null;
  lastRunId: string | null;
  nextRunAt: string | null;
  triggers: WorkflowTrigger[];
  updatedAt: string;
}

export interface WorkflowNodeDef {
  type: string;
  [key: string]: unknown;
}

export interface WorkflowEdgeDef {
  from: string;
  to: string;
  port: string;
}

export interface WorkflowDefinition {
  name: string;
  slug: string;
  owner: string;
  description?: string;
  tags?: string[];
  inputs?: {
    type: string;
    required?: string[];
    properties?: Record<string, { type?: string; default?: unknown }>;
  };
  triggers: unknown[];
  policies: Record<string, unknown>;
  layout?: Record<string, { x: number; y: number }>;
  nodes: Record<string, WorkflowNodeDef>;
  edges: WorkflowEdgeDef[];
}

export interface WorkflowRun {
  id: string;
  slug: string;
  status:
    | 'queued'
    | 'running'
    | 'waiting'
    | 'succeeded'
    | 'failed'
    | 'cancelled';
  triggerId: string | null;
  inputs: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  parentRunId: string | null;
  forkedAtNode: string | null;
}

export interface WorkflowStep {
  id: number;
  nodeId: string;
  attempt: number;
  status: string;
  port: string | null;
  output: unknown;
  error: string | null;
  agentSessionId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface WorkflowWait {
  id: string;
  runId: string;
  slug: string | null;
  workflowName: string | null;
  nodeId: string;
  kind: string;
  prompt: string | null;
  options: string[] | null;
  fields: unknown;
  targets: string[] | null;
  expiresAt: string | null;
  createdAt: string;
  status?: string;
  response?: unknown;
  responder?: string | null;
  respondedVia?: string | null;
}

export interface RunTimelineEntry {
  id: number;
  ts: string;
  node_id: string | null;
  kind: string;
  payload: unknown;
}

export type WorkflowStreamEvent =
  | {
      type: 'run.status';
      runId: string;
      slug: string;
      status: string;
      ts: number;
    }
  | {
      type: 'step.status';
      runId: string;
      slug: string;
      nodeId: string;
      status: string;
      port?: string | null;
      ts: number;
    }
  | {
      type: 'wait.opened';
      runId: string;
      slug: string;
      nodeId: string;
      waitId: string;
      ts: number;
    }
  | {
      type: 'wait.resolved';
      runId: string;
      slug: string;
      nodeId: string;
      waitId: string;
      via: string;
      ts: number;
    }
  | { type: 'workflow.changed'; slug: string; ts: number };

export interface HealthCheck {
  name: string;
  status: 'ok' | 'fail' | 'warn';
  detail: string;
}

export interface RegisteredAgent {
  jid: string;
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  primary?: boolean;
  requiresTrigger?: boolean;
  email?: { address: string; interval?: string };
}

export type ChannelKind =
  | 'web'
  | 'whatsapp-dm'
  | 'whatsapp-group'
  | 'telegram'
  | 'imessage';

export interface AvailableChannel {
  jid: string;
  name: string;
  kind: ChannelKind;
  lastActivity: string | null;
}

export interface UserAgent {
  folder: string;
  name: string;
  trigger: string;
  webJid: string;
  model: string;
  effort: string;
}

export interface SlashCommand {
  name: string;
  description: string;
}

export interface ChatMessage {
  id: string;
  chatJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
}

export interface WebSession {
  id: string;
  folder: string;
  title: string | null;
  sdkSessionId: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  pinned: boolean;
  archived: boolean;
}

// Admin-only: SDK session metadata + parsed transcript message.
export interface TranscriptSession {
  sessionId: string;
  summary: string;
  firstPrompt?: string;
  lastModified: number;
  createdAt?: number;
}

export interface TranscriptMessage {
  sender: string;
  timestamp: string;
  content: string;
}

export interface SetupModel {
  id: string;
  alias: string;
  short?: string;
  label: string;
  contextWindow: number;
}

export interface SetupStatus {
  onboarded: boolean;
  hasPassword: boolean;
  hasClaudeAuth: boolean;
  hasModel: boolean;
  assistantName: string;
  timezone: string;
  model: string;
  models: SetupModel[];
  whatsapp: { paired: boolean };
  telegram: { configured: boolean };
  templates: { USER: string; SOUL: string; IDENTITY: string };
}

export interface SettingRow {
  key: string;
  value: string;
  secret: boolean;
  updatedAt: string;
}

export interface McpServer {
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  updatedAt: string;
}

export interface InstallConfig {
  home: string;
  configDb: string | null;
  varDir: string;
  cacheDir: string;
  onboarded: boolean;
}

export type ContextScope = 'shared' | 'agent';

export interface ContextFile {
  scope: ContextScope;
  folder: string | null;
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
}

export interface ContextListing {
  shared: ContextFile[];
  agents: Array<{ folder: string; files: ContextFile[] }>;
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function bounceToLogin(): void {
  if (typeof window === 'undefined') return;
  const path = window.location.pathname + window.location.search;
  window.location.href = `/login?next=${encodeURIComponent(path)}`;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: 'no-store' });
  if (res.status === 401) {
    bounceToLogin();
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

// Same as get, but a 404 is an answer rather than a failure: "no such row
// yet". Used where absence is the normal first-run case.
async function getOptional<T>(path: string): Promise<T | null> {
  const res = await fetch(path, { cache: 'no-store' });
  if (res.status === 401) {
    bounceToLogin();
    throw new Error('unauthorized');
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

async function send<T>(
  path: string,
  method: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body) headers['content-type'] = 'application/json';
  const csrf = readCookie('nc_csrf');
  if (csrf) headers['x-csrf-token'] = csrf;
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    bounceToLogin();
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

export const api = {
  // user
  userAgents: () =>
    get<{
      agents: UserAgent[];
      main: string;
      defaults: { model: string; effort: string };
    }>('/api/user/agents'),
  updateAgent: (folder: string, body: { model?: string; effort?: string }) =>
    send<{ ok: boolean; model: string; effort: string }>(
      `/api/user/agents/${encodeURIComponent(folder)}`,
      'PATCH',
      body,
    ),
  chat: (folder: string, sessionId: string, text: string, clientId?: string) =>
    send<{ ok: boolean; jid: string; sessionId: string }>(
      '/api/user/chat',
      'POST',
      { folder, sessionId, text, clientId },
    ),
  chatMessages: (
    folder: string,
    sessionId: string,
    opts?: { before?: string; limit?: number },
  ) => {
    const params = new URLSearchParams({ folder, sessionId });
    if (opts?.before) params.set('before', opts.before);
    if (opts?.limit) params.set('limit', String(opts.limit));
    return get<{ messages: ChatMessage[] }>(
      `/api/user/chat/messages?${params.toString()}`,
    );
  },
  chatSessions: (folder: string, includeArchived = false) => {
    const params = new URLSearchParams({ folder });
    if (includeArchived) params.set('includeArchived', '1');
    return get<{ sessions: WebSession[] }>(
      `/api/user/chat/sessions?${params.toString()}`,
    );
  },
  createChatSession: (folder: string, title?: string) =>
    send<{ id: string; chatJid: string; folder: string; title: string | null }>(
      '/api/user/chat/sessions',
      'POST',
      { folder, title },
    ),
  renameChatSession: (folder: string, id: string, title: string) =>
    send<{ ok: boolean }>(
      `/api/user/chat/sessions/${encodeURIComponent(id)}`,
      'PATCH',
      { folder, title },
    ),
  regenerateChatSessionTitle: (folder: string, id: string) =>
    send<{ ok: boolean; title: string | null }>(
      `/api/user/chat/sessions/${encodeURIComponent(id)}/regenerate-title`,
      'POST',
      { folder },
    ),
  pinChatSession: (folder: string, id: string, pinned: boolean) =>
    send<{ ok: boolean }>(
      `/api/user/chat/sessions/${encodeURIComponent(id)}`,
      'PATCH',
      { folder, pinned },
    ),
  archiveChatSession: (folder: string, id: string, archived: boolean) =>
    send<{ ok: boolean }>(
      `/api/user/chat/sessions/${encodeURIComponent(id)}`,
      'PATCH',
      { folder, archived },
    ),
  deleteChatSession: (folder: string, id: string, hard = false) =>
    send<{ ok: boolean }>(
      `/api/user/chat/sessions/${encodeURIComponent(id)}?folder=${encodeURIComponent(folder)}${hard ? '&hard=1' : ''}`,
      'DELETE',
    ),
  commands: () => get<{ commands: SlashCommand[] }>('/api/user/commands'),
  agentMediaUrl: (folder: string, absPath: string) =>
    `/api/user/agent-media?folder=${encodeURIComponent(folder)}&path=${encodeURIComponent(absPath)}`,
  chatUpload: (payload: {
    folder: string;
    sessionId: string;
    kind: 'image' | 'video' | 'audio' | 'document' | 'voice';
    fileName?: string;
    mimeType?: string;
    dataB64: string;
    caption?: string;
  }) =>
    send<{ ok: boolean; kind: string; transcript?: string; path?: string }>(
      '/api/user/chat/upload',
      'POST',
      payload,
    ),
  // admin
  skills: () => get<{ skills: SkillInfo[] }>('/api/admin/skills'),
  skillSources: () =>
    get<{ sources: SkillSource[] }>('/api/admin/skills/sources'),
  skillsAvailable: (source: string) =>
    get<{ skills: SkillInfo[] }>(
      `/api/admin/skills/available?source=${encodeURIComponent(source)}`,
    ),
  installSkill: (sourcePath: string, name: string) =>
    send<{ ok: boolean }>('/api/admin/skills/install', 'POST', {
      sourcePath,
      name,
    }),
  uninstallSkill: (name: string) =>
    send<{ ok: boolean }>('/api/admin/skills/uninstall', 'POST', { name }),
  syncSkills: () =>
    send<{ synced: string[]; skipped: string[] }>(
      '/api/admin/skills/sync',
      'POST',
    ),
  addSkillSource: (dir: string) =>
    send<{ ok: boolean }>('/api/admin/skills/sources', 'POST', { dir }),
  skillFiles: (name: string) =>
    get<{ name: string; files: SkillFileInfo[] }>(
      `/api/admin/skills/files?name=${encodeURIComponent(name)}`,
    ),
  skillFileRead: (name: string, path: string) =>
    get<SkillFileContent>(
      `/api/admin/skills/file?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`,
    ),
  skillFileWrite: (name: string, path: string, content: string) =>
    send<{ ok: boolean; updatedAt: string }>('/api/admin/skills/file', 'PUT', {
      name,
      path,
      content,
    }),
  skillFileDelete: (name: string, path: string) =>
    send<{ ok: boolean }>(
      `/api/admin/skills/file?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`,
      'DELETE',
    ),
  events: (limit = 200) =>
    get<{ events: EventRecord[] }>(`/api/admin/events?limit=${limit}`),
  agents: () => get<{ agents: RegisteredAgent[] }>('/api/admin/agents'),
  agentChannels: () =>
    get<{ channels: AvailableChannel[] }>('/api/admin/agents/channels'),
  agentFolders: () => get<{ folders: string[] }>('/api/admin/agents/folders'),
  createAgent: (body: {
    folder: string;
    name: string;
    templateFolder?: string;
  }) =>
    send<{ ok: boolean; folder: string; wiredJid: string }>(
      '/api/admin/agents',
      'POST',
      body,
    ),
  wireAgent: (body: {
    folder: string;
    jid: string;
    name?: string;
    trigger?: string;
    primary?: boolean;
    // email channel only
    address?: string;
    interval?: string;
  }) =>
    send<{ ok: boolean; jid: string; agent: RegisteredAgent }>(
      '/api/admin/agents/wire',
      'POST',
      body,
    ),
  updateAgentEntry: (body: {
    jid: string;
    name?: string;
    trigger?: string;
    primary?: boolean;
  }) =>
    send<{ ok: boolean; jid: string; agent: RegisteredAgent }>(
      '/api/admin/agents/by-jid',
      'PATCH',
      body,
    ),
  renameAgent: (folder: string, name: string) =>
    send<{ ok: boolean; folder: string; name: string; updated: string[] }>(
      '/api/admin/agents/by-folder',
      'PATCH',
      { folder, name },
    ),
  unwireAgent: (jid: string) =>
    send<{ ok: boolean }>(
      `/api/admin/agents/by-jid?jid=${encodeURIComponent(jid)}`,
      'DELETE',
    ),
  deleteAgent: (
    folder: string,
    opts?: { deleteFiles?: boolean; deleteVar?: boolean },
  ) => {
    const params = new URLSearchParams({ folder });
    if (opts?.deleteFiles) params.set('deleteFiles', '1');
    if (opts?.deleteVar) params.set('deleteVar', '1');
    return send<{
      ok: boolean;
      unwired: string[];
      filesDeleted: boolean;
      fileError?: string;
      folderPath: string;
    }>(`/api/admin/agents/by-folder?${params.toString()}`, 'DELETE');
  },
  transcriptSessions: (folder: string, limit = 50) =>
    get<{ sessions: TranscriptSession[] }>(
      `/api/admin/transcripts/sessions?folder=${encodeURIComponent(folder)}&limit=${limit}`,
    ),
  transcriptMessages: (folder: string, sessionId: string) =>
    get<{ messages: TranscriptMessage[] }>(
      `/api/admin/transcripts/messages?folder=${encodeURIComponent(folder)}&sessionId=${encodeURIComponent(sessionId)}`,
    ),
  contextList: () => get<ContextListing>('/api/admin/context'),
  contextRead: (scope: ContextScope, folder: string | null, name: string) => {
    const p = new URLSearchParams({ scope, name });
    if (scope === 'agent' && folder) p.set('folder', folder);
    return get<{
      scope: ContextScope;
      folder: string | null;
      name: string;
      content: string;
      modifiedAt: string;
    }>(`/api/admin/context/file?${p.toString()}`);
  },
  // Prefill helper for the setup wizard: null when the file does not exist yet.
  contextReadIfExists: (
    scope: ContextScope,
    folder: string | null,
    name: string,
  ) => {
    const p = new URLSearchParams({ scope, name });
    if (scope === 'agent' && folder) p.set('folder', folder);
    return getOptional<{
      scope: ContextScope;
      folder: string | null;
      name: string;
      content: string;
      modifiedAt: string;
    }>(`/api/admin/context/file?${p.toString()}`);
  },
  contextWrite: (
    scope: ContextScope,
    folder: string | null,
    name: string,
    content: string,
  ) => {
    const p = new URLSearchParams({ scope, name });
    if (scope === 'agent' && folder) p.set('folder', folder);
    return send<{ ok: boolean; modifiedAt: string }>(
      `/api/admin/context/file?${p.toString()}`,
      'PUT',
      { content },
    );
  },
  contextCreate: (
    scope: ContextScope,
    folder: string | null,
    name: string,
    content = '',
  ) => {
    const p = new URLSearchParams({ scope, name });
    if (scope === 'agent' && folder) p.set('folder', folder);
    return send<{ ok: boolean; modifiedAt: string }>(
      `/api/admin/context/file?${p.toString()}`,
      'POST',
      { content },
    );
  },
  contextDelete: (scope: ContextScope, folder: string | null, name: string) => {
    const p = new URLSearchParams({ scope, name });
    if (scope === 'agent' && folder) p.set('folder', folder);
    return send<{ ok: boolean }>(
      `/api/admin/context/file?${p.toString()}`,
      'DELETE',
    );
  },
  health: () => get<{ checks: HealthCheck[] }>('/api/admin/health'),
  installConfig: () => get<InstallConfig>('/api/admin/config'),

  // setup + settings
  setupStatus: () => get<SetupStatus>('/api/setup/status'),
  setupPassword: (password: string) =>
    send<{ ok: boolean }>('/api/setup/password', 'POST', { password }),
  setupComplete: () =>
    send<{ ok: boolean; restarting: boolean }>('/api/setup/complete', 'POST'),
  restart: () =>
    send<{ ok: boolean; restarting: boolean }>('/api/admin/restart', 'POST'),
  settingsList: () => get<{ settings: SettingRow[] }>('/api/admin/settings'),
  settingsPut: (values: Record<string, string | null>, secret?: string[]) =>
    send<{ ok: boolean; changed: string[]; restartRequired: boolean }>(
      '/api/admin/settings',
      'PUT',
      { values, ...(secret?.length ? { secret } : {}) },
    ),
  mcpList: () => get<{ servers: McpServer[] }>('/api/admin/mcp'),
  mcpPut: (name: string, config: Record<string, unknown>, enabled = true) =>
    send<{ ok: boolean; server: McpServer; restartRequired: boolean }>(
      '/api/admin/mcp',
      'PUT',
      { name, config, enabled },
    ),
  mcpDelete: (name: string) =>
    send<{ ok: boolean; restartRequired: boolean }>(
      `/api/admin/mcp?name=${encodeURIComponent(name)}`,
      'DELETE',
    ),

  // workflows
  workflows: () => get<{ workflows: WorkflowSummary[] }>('/api/workflows'),
  workflow: (slug: string) =>
    get<{
      workflow: WorkflowSummary;
      definition: WorkflowDefinition;
      runs: WorkflowRun[];
    }>(`/api/workflows/${encodeURIComponent(slug)}`),
  exportWorkflow: async (slug: string): Promise<Blob> => {
    const res = await fetch(
      `/api/workflows/${encodeURIComponent(slug)}/export`,
      { cache: 'no-store' },
    );
    if (res.status === 401) {
      bounceToLogin();
      throw new Error('unauthorized');
    }
    if (!res.ok) throw new Error(`${res.status} export ${slug}`);
    return res.blob();
  },
  importWorkflow: (definition: unknown, replace = false) =>
    send<{ ok: boolean; definition: WorkflowDefinition }>(
      `/api/workflows/import${replace ? '?replace=1' : ''}`,
      'POST',
      { definition },
    ),
  saveWorkflow: (slug: string, definition: unknown) =>
    send<{ ok: boolean; definition: WorkflowDefinition }>(
      `/api/workflows/${encodeURIComponent(slug)}`,
      'PUT',
      { definition },
    ),
  deleteWorkflow: (slug: string) =>
    send<{ ok: boolean }>(
      `/api/workflows/${encodeURIComponent(slug)}`,
      'DELETE',
    ),
  runWorkflow: (slug: string, inputs: Record<string, unknown> = {}) =>
    send<{
      ok: boolean;
      status: string;
      runId: string | null;
      run: WorkflowRun | null;
    }>(`/api/workflows/${encodeURIComponent(slug)}/run`, 'POST', { inputs }),
  setWorkflowEnabled: (slug: string, enabled: boolean) =>
    send<{ ok: boolean }>(
      `/api/workflows/${encodeURIComponent(slug)}/enabled`,
      'POST',
      { enabled },
    ),
  workflowRuns: (slug: string, limit = 50) =>
    get<{ runs: WorkflowRun[] }>(
      `/api/workflows/${encodeURIComponent(slug)}/runs?limit=${limit}`,
    ),
  triggers: (slug?: string) =>
    get<{ triggers: WorkflowTrigger[] }>(
      slug ? `/api/triggers?slug=${encodeURIComponent(slug)}` : '/api/triggers',
    ),
  createTrigger: (body: {
    slug: string;
    type: string;
    config?: Record<string, unknown>;
    args?: Record<string, unknown>;
  }) =>
    send<{ ok: boolean; trigger: WorkflowTrigger; token: string | null }>(
      '/api/triggers',
      'POST',
      body,
    ),
  updateTrigger: (
    id: string,
    body: {
      enabled?: boolean;
      config?: Record<string, unknown>;
      args?: Record<string, unknown>;
    },
  ) =>
    send<{ ok: boolean; trigger: WorkflowTrigger }>(
      `/api/triggers/${encodeURIComponent(id)}`,
      'PATCH',
      body,
    ),
  deleteTrigger: (id: string) =>
    send<{ ok: boolean }>(`/api/triggers/${encodeURIComponent(id)}`, 'DELETE'),
  run: (id: string) =>
    get<{
      run: WorkflowRun;
      definition: WorkflowDefinition;
      steps: WorkflowStep[];
      waits: WorkflowWait[];
      timeline: RunTimelineEntry[];
    }>(`/api/runs/${encodeURIComponent(id)}`),
  cancelRun: (id: string, reason?: string) =>
    send<{ ok: boolean }>(
      `/api/runs/${encodeURIComponent(id)}/cancel`,
      'POST',
      {
        reason,
      },
    ),
  retryRun: (
    id: string,
    from: string,
    override?: { node: string; output: unknown },
  ) =>
    send<{ ok: boolean; runId: string }>(
      `/api/runs/${encodeURIComponent(id)}/retry`,
      'POST',
      { from, ...(override ?? {}) },
    ),
  waits: () => get<{ waits: WorkflowWait[] }>('/api/waits'),
  respondToWait: (id: string, response: unknown) =>
    send<{ ok: boolean }>(
      `/api/waits/${encodeURIComponent(id)}/respond`,
      'POST',
      { response },
    ),
};

export type ChatStreamEvent =
  | { type: 'message'; jid: string; id: number; text: string; ts: number }
  | { type: 'user'; jid: string; text: string; ts: number; clientId?: string }
  | { type: 'edit'; jid: string; id: number; text: string; ts: number }
  | { type: 'delete'; jid: string; id: number }
  | { type: 'typing'; jid: string; isTyping: boolean }
  | { type: 'activity'; jid: string; label: string | null }
  | {
      type: 'media';
      jid: string;
      id: number;
      mediaType: string;
      caption?: string;
      url?: string;
      ts: number;
    };
