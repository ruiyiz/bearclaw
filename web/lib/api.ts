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

export interface EventRecord {
  id: number;
  type: string;
  payload: string;
  emitted_at: string;
  processed: number;
}

export interface Handler {
  id: string;
  group_folder: string;
  prompt: string;
  context_mode: string;
  event_type: string;
  filter: string | null;
  cron: string | null;
  next_run: string | null;
  cooldown_ms: number;
  last_triggered: string | null;
  max_triggers: number | null;
  trigger_count: number;
  status: string;
  created_at: string;
}

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
}

export interface UserAgent {
  folder: string;
  name: string;
  trigger: string;
  webJid: string;
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
    get<{ agents: UserAgent[]; main: string }>('/api/user/agents'),
  chat: (folder: string, sessionId: string, text: string) =>
    send<{ ok: boolean; jid: string; sessionId: string }>(
      '/api/user/chat',
      'POST',
      { folder, sessionId, text },
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
  events: (limit = 200) =>
    get<{ events: EventRecord[] }>(`/api/admin/events?limit=${limit}`),
  handlers: () => get<{ handlers: Handler[] }>('/api/admin/handlers'),
  pauseHandler: (id: string) =>
    send<{ ok: boolean }>(
      `/api/admin/handlers/${encodeURIComponent(id)}/pause`,
      'POST',
    ),
  resumeHandler: (id: string) =>
    send<{ ok: boolean }>(
      `/api/admin/handlers/${encodeURIComponent(id)}/resume`,
      'POST',
    ),
  deleteHandler: (id: string) =>
    send<{ ok: boolean }>(
      `/api/admin/handlers/${encodeURIComponent(id)}`,
      'DELETE',
    ),
  agents: () => get<{ agents: RegisteredAgent[] }>('/api/admin/agents'),
  transcriptSessions: (folder: string, limit = 50) =>
    get<{ sessions: TranscriptSession[] }>(
      `/api/admin/transcripts/sessions?folder=${encodeURIComponent(folder)}&limit=${limit}`,
    ),
  transcriptMessages: (folder: string, sessionId: string) =>
    get<{ messages: TranscriptMessage[] }>(
      `/api/admin/transcripts/messages?folder=${encodeURIComponent(folder)}&sessionId=${encodeURIComponent(sessionId)}`,
    ),
  health: () => get<{ checks: HealthCheck[] }>('/api/admin/health'),
  heartbeat: (folder: string, lines = 40) =>
    get<{ folder: string; log: string }>(
      `/api/admin/heartbeat?folder=${encodeURIComponent(folder)}&lines=${lines}`,
    ),
};

export type ChatStreamEvent =
  | { type: 'message'; jid: string; id: number; text: string; ts: number }
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
