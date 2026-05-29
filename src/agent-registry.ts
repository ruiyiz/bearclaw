// Pure transforms over the registered-agents registry.
//
// On disk the registry is nested (folder-outer, channels-inner) — see
// AgentRegistry / StoredAgent in types.ts. The router, channels, event bus and
// heartbeat all consume a *flat* per-channel view keyed by routing jid
// (RegisteredAgent). `resolveRegistry` derives that view; index.ts rebuilds it
// on every mutation so agent-level fields (name, heartbeat, containerConfig)
// can never drift between a folder's channels.
//
// Kept dependency-free so the migration script and admin/data can import it.

import type {
  AgentRegistry,
  RegisteredAgent,
  StoredAgent,
  StoredChannel,
} from './types.js';

// Reconstruct the routing jid for a stored channel key. The web and email
// channels route by folder, so their stored keys are bare tokens; every other
// channel key is already its routing jid.
export function jidForChannelKey(folder: string, channelKey: string): string {
  if (channelKey === 'web') return `web:${folder}`;
  if (channelKey === 'email') return `email:${folder}`;
  return channelKey;
}

// Derive the flat, jid-keyed RegisteredAgent view from the nested registry.
// Each channel (including email) resolves to its own routing entry. The email
// entry carries the address/interval and, like web, never triggers or applies
// off-hours — email always replies, and delivery is structural (by jid).
export function resolveRegistry(
  reg: AgentRegistry,
): Record<string, RegisteredAgent> {
  const out: Record<string, RegisteredAgent> = {};
  for (const [folder, agent] of Object.entries(reg)) {
    for (const [channelKey, ch] of Object.entries(agent.channels)) {
      const jid = jidForChannelKey(folder, channelKey);
      const resolved: RegisteredAgent = {
        name: agent.name,
        folder,
        trigger: ch.trigger ?? '',
        added_at: ch.added_at,
      };
      if (channelKey === 'email') {
        if (!ch.address) continue; // misconfigured email channel — skip
        resolved.trigger = '';
        resolved.email = {
          address: ch.address,
          ...(ch.interval ? { interval: ch.interval } : {}),
        };
      } else {
        if (ch.requiresTrigger !== undefined)
          resolved.requiresTrigger = ch.requiresTrigger;
        if (ch.primary) resolved.primary = true;
        if (ch.activeHours) resolved.activeHours = ch.activeHours;
      }
      if (agent.heartbeat) resolved.heartbeat = agent.heartbeat;
      if (agent.containerConfig)
        resolved.containerConfig = agent.containerConfig;
      out[jid] = resolved;
    }
  }
  return out;
}

// True when `data` already has the nested shape (or is empty). A flat
// registry (jid-keyed RegisteredAgent records) has no `channels` member on its
// values, so it returns false → loader rejects it and asks for migration.
export function isNestedRegistry(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const values = Object.values(data as Record<string, unknown>);
  if (values.length === 0) return true;
  return values.every(
    (v) =>
      !!v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      'channels' in (v as object),
  );
}

// Old flat record: jid → RegisteredAgent-ish (with the legacy `email` field).
type FlatAgent = RegisteredAgent;

// One-shot transform: flat jid-keyed registry → nested folder/channels.
// Agent-level fields are hoisted (siblings are consistent post folder-wide
// rename, so first-write-wins is safe); channel-level fields move under
// channels[jid]; the legacy `email` field becomes channels.email.
export function migrateFlatToNested(
  flat: Record<string, FlatAgent>,
): AgentRegistry {
  const out: AgentRegistry = {};
  for (const [jid, a] of Object.entries(flat)) {
    const folder = a.folder;
    if (!folder) {
      throw new Error(`flat entry ${jid} has no folder — cannot migrate`);
    }
    let entry: StoredAgent = out[folder];
    if (!entry) {
      entry = { name: a.name, channels: {} };
      out[folder] = entry;
    }
    if (a.name) entry.name = a.name;
    if (a.heartbeat && !entry.heartbeat) entry.heartbeat = a.heartbeat;
    if (a.containerConfig && !entry.containerConfig)
      entry.containerConfig = a.containerConfig;

    const channelKey = jid.startsWith('web:') ? 'web' : jid;
    const ch: StoredChannel = { added_at: a.added_at };
    // Web threads never trigger — leave the trigger off entirely. Other
    // channels keep their trigger (even the empty string, which means
    // "respond to everything").
    if (channelKey !== 'web') ch.trigger = a.trigger ?? '';
    if (a.requiresTrigger !== undefined) ch.requiresTrigger = a.requiresTrigger;
    if (a.primary) ch.primary = true;
    if (a.activeHours) ch.activeHours = a.activeHours;
    entry.channels[channelKey] = ch;

    if (a.email && a.email.address) {
      entry.channels.email = {
        added_at: a.added_at,
        address: a.email.address,
        ...(a.email.interval ? { interval: a.email.interval } : {}),
      };
    }
  }
  return out;
}
