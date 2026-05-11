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

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

async function send<T>(
  path: string,
  method: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

export const api = {
  // user
  userAgents: () =>
    get<{ agents: UserAgent[]; main: string }>('/api/user/agents'),
  chat: (folder: string, text: string) =>
    send<{ ok: boolean; jid: string }>('/api/user/chat', 'POST', {
      folder,
      text,
    }),
  userEvents: (limit = 50) =>
    get<{ events: EventRecord[] }>(`/api/user/events?limit=${limit}`),
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
  health: () => get<{ checks: HealthCheck[] }>('/api/admin/health'),
  heartbeat: (folder: string, lines = 40) =>
    get<{ folder: string; log: string }>(
      `/api/admin/heartbeat?folder=${encodeURIComponent(folder)}&lines=${lines}`,
    ),
};

export type ChatStreamEvent =
  | { type: 'message'; jid: string; id: number; text: string }
  | { type: 'edit'; jid: string; id: number; text: string }
  | { type: 'delete'; jid: string; id: number }
  | { type: 'typing'; jid: string; isTyping: boolean }
  | {
      type: 'media';
      jid: string;
      id: number;
      mediaType: string;
      caption?: string;
      url?: string;
    };
