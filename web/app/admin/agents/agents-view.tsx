'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type AvailableChannel,
  type ChannelKind,
  type RegisteredAgent,
} from '@/lib/api';

interface AgentGroup {
  folder: string;
  name: string;
  trigger: string;
  entries: RegisteredAgent[];
}

const KIND_LABEL: Record<ChannelKind, string> = {
  web: 'Web',
  'whatsapp-dm': 'WhatsApp DM',
  'whatsapp-group': 'WhatsApp Group',
  telegram: 'Telegram',
  imessage: 'iMessage',
};

function classifyJid(jid: string): ChannelKind | 'unknown' {
  if (jid.startsWith('web:')) return 'web';
  if (jid.startsWith('tg:')) return 'telegram';
  if (jid.startsWith('imsg:')) return 'imessage';
  if (jid.endsWith('@g.us')) return 'whatsapp-group';
  if (jid.endsWith('@s.whatsapp.net')) return 'whatsapp-dm';
  return 'unknown';
}

function groupByFolder(agents: RegisteredAgent[]): AgentGroup[] {
  const map = new Map<string, AgentGroup>();
  for (const a of agents) {
    const g = map.get(a.folder);
    if (g) {
      g.entries.push(a);
    } else {
      map.set(a.folder, {
        folder: a.folder,
        name: a.name,
        trigger: a.trigger,
        entries: [a],
      });
    }
  }
  return [...map.values()].sort((a, b) => a.folder.localeCompare(b.folder));
}

export function AgentsView() {
  const [agents, setAgents] = useState<RegisteredAgent[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [channels, setChannels] = useState<AvailableChannel[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [wireFor, setWireFor] = useState<AgentGroup | null>(null);
  const [editEntry, setEditEntry] = useState<RegisteredAgent | null>(null);
  const [deleteGroup, setDeleteGroup] = useState<AgentGroup | null>(null);

  const reload = useCallback(async () => {
    try {
      const [a, f, c] = await Promise.all([
        api.agents(),
        api.agentFolders(),
        api.agentChannels(),
      ]);
      setAgents(a.agents);
      setFolders(f.folders);
      setChannels(c.channels);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const groups = useMemo(() => groupByFolder(agents), [agents]);

  async function unwire(jid: string): Promise<void> {
    if (!confirm(`Remove channel ${jid}?`)) return;
    setBusy(jid);
    try {
      await api.unwireAgent(jid);
      await reload();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Agents</h2>
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-md bg-[color:var(--accent)] text-white px-3 py-1.5 text-sm"
        >
          + New agent
        </button>
      </header>
      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 text-red-500 px-3 py-2 text-xs">
          {error}
        </div>
      )}
      <ul className="space-y-3">
        {groups.map((g) => (
          <li
            key={g.folder}
            className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-3 space-y-2"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-medium">{g.name}</div>
                <div className="text-xs text-[color:var(--muted)]">
                  folder={g.folder} · trigger={g.trigger || '—'}
                </div>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => setWireFor(g)}
                  className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:border-[color:var(--accent)]"
                >
                  + Channel
                </button>
                <button
                  onClick={() => setDeleteGroup(g)}
                  disabled={g.folder === 'main'}
                  className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:border-red-500 hover:text-red-500 disabled:opacity-40"
                  title={
                    g.folder === 'main'
                      ? 'Cannot delete main agent'
                      : 'Delete agent'
                  }
                >
                  Delete
                </button>
              </div>
            </div>
            <ul className="space-y-1">
              {g.entries.map((e) => {
                const kind = classifyJid(e.jid);
                const label = kind === 'unknown' ? 'Channel' : KIND_LABEL[kind];
                return (
                  <li
                    key={e.jid}
                    className="flex items-center justify-between gap-2 rounded-md border border-[color:var(--border)] px-2 py-1.5"
                  >
                    <div className="min-w-0">
                      <div className="text-xs">
                        <span className="font-medium">{label}</span>
                        {e.primary && (
                          <span className="ml-2 rounded bg-[color:var(--accent)]/20 text-[color:var(--accent)] px-1.5 py-0.5 text-[10px]">
                            primary
                          </span>
                        )}
                      </div>
                      <code className="text-[10px] text-[color:var(--muted)] block truncate">
                        {e.jid}
                      </code>
                      <div className="text-[10px] text-[color:var(--muted)]">
                        name={e.name} · trigger={e.trigger || '—'} ·{' '}
                        {new Date(e.added_at).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => setEditEntry(e)}
                        className="text-[10px] px-2 py-1 rounded-md border border-[color:var(--border)] hover:border-[color:var(--accent)]"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => unwire(e.jid)}
                        disabled={busy === e.jid}
                        className="text-[10px] px-2 py-1 rounded-md border border-[color:var(--border)] hover:border-red-500 hover:text-red-500 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
        {groups.length === 0 && (
          <li className="text-sm text-[color:var(--muted)]">
            No agents registered.
          </li>
        )}
      </ul>

      {showCreate && (
        <CreateAgentModal
          folders={folders}
          onClose={() => setShowCreate(false)}
          onDone={async () => {
            setShowCreate(false);
            await reload();
          }}
        />
      )}
      {wireFor && (
        <WireChannelModal
          group={wireFor}
          channels={channels}
          onClose={() => setWireFor(null)}
          onDone={async () => {
            setWireFor(null);
            await reload();
          }}
        />
      )}
      {editEntry && (
        <EditEntryModal
          entry={editEntry}
          onClose={() => setEditEntry(null)}
          onDone={async () => {
            setEditEntry(null);
            await reload();
          }}
        />
      )}
      {deleteGroup && (
        <DeleteAgentModal
          group={deleteGroup}
          onClose={() => setDeleteGroup(null)}
          onDone={async () => {
            setDeleteGroup(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

// ─── Modals ────────────────────────────────────────────────────────────────

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button
            onClick={onClose}
            className="text-xs text-[color:var(--muted)] hover:text-[color:var(--fg)]"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputCls =
  'w-full bg-[color:var(--card)] border border-[color:var(--border)] rounded-md px-2 py-1.5 text-sm';

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <div className="text-xs uppercase tracking-wide text-[color:var(--muted)]">
        {label}
      </div>
      {children}
    </label>
  );
}

function CreateAgentModal({
  folders,
  onClose,
  onDone,
}: {
  folders: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [templateFolder, setTemplateFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await api.createAgent({
        folder: folder.trim(),
        name: name.trim() || folder.trim(),
        templateFolder: templateFolder || undefined,
      });
      onDone();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New agent" onClose={onClose}>
      <Field label="Folder">
        <input
          className={inputCls}
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          placeholder="e.g. nova"
        />
      </Field>
      <Field label="Display name">
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="defaults to folder"
        />
      </Field>
      <Field label="Template (optional)">
        <select
          className={inputCls}
          value={templateFolder}
          onChange={(e) => setTemplateFolder(e.target.value)}
        >
          <option value="">— blank —</option>
          {folders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </Field>
      <div className="text-xs text-[color:var(--muted)]">
        A web channel is wired automatically. Add other channels afterward with
        “+ Channel”.
      </div>
      {err && <div className="text-xs text-red-500">{err}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onClose}
          className="text-xs px-3 py-1.5 rounded-md border border-[color:var(--border)]"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={busy || !folder.trim()}
          className="text-xs px-3 py-1.5 rounded-md bg-[color:var(--accent)] text-white disabled:opacity-40"
        >
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
    </Modal>
  );
}

function WireChannelModal({
  group,
  channels,
  onClose,
  onDone,
}: {
  group: AgentGroup;
  channels: AvailableChannel[];
  onClose: () => void;
  onDone: () => void;
}) {
  const hasWeb = group.entries.some((e) => e.jid === `web:${group.folder}`);
  const [kind, setKind] = useState<'web' | 'existing' | 'manual'>(
    hasWeb ? 'existing' : 'web',
  );
  const [wireJid, setWireJid] = useState('');
  const [manualJid, setManualJid] = useState('');
  const [name, setName] = useState(group.name);
  const [trigger, setTrigger] = useState(group.trigger);
  const [primary, setPrimary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const jid =
        kind === 'web'
          ? `web:${group.folder}`
          : kind === 'manual'
            ? manualJid.trim()
            : wireJid;
      if (!jid) {
        setErr('select a channel');
        setBusy(false);
        return;
      }
      await api.wireAgent({
        folder: group.folder,
        jid,
        name,
        trigger,
        primary,
      });
      onDone();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Add channel to ${group.folder}`} onClose={onClose}>
      <Field label="Channel type">
        <select
          className={inputCls}
          value={kind}
          onChange={(e) =>
            setKind(e.target.value as 'web' | 'existing' | 'manual')
          }
        >
          <option value="web" disabled={hasWeb}>
            Web (web:{group.folder}){hasWeb ? ' — already wired' : ''}
          </option>
          <option value="existing">Pick an existing chat</option>
          <option value="manual">Enter JID manually</option>
        </select>
      </Field>
      {kind === 'existing' && (
        <Field label="Chat">
          <select
            className={inputCls}
            value={wireJid}
            onChange={(e) => setWireJid(e.target.value)}
          >
            <option value="">— select —</option>
            {channels.map((c) => (
              <option key={c.jid} value={c.jid}>
                [{KIND_LABEL[c.kind]}] {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {kind === 'manual' && (
        <Field label="JID">
          <input
            className={inputCls}
            value={manualJid}
            onChange={(e) => setManualJid(e.target.value)}
            placeholder="tg:123 · imsg:17 · 123@g.us"
          />
        </Field>
      )}
      <Field label="Name on this channel">
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Trigger on this channel">
        <input
          className={inputCls}
          value={trigger}
          onChange={(e) => setTrigger(e.target.value)}
          placeholder="empty = always respond"
        />
      </Field>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={primary}
          onChange={(e) => setPrimary(e.target.checked)}
        />
        mark as primary channel
      </label>
      {err && <div className="text-xs text-red-500">{err}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onClose}
          className="text-xs px-3 py-1.5 rounded-md border border-[color:var(--border)]"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded-md bg-[color:var(--accent)] text-white disabled:opacity-40"
        >
          {busy ? 'Wiring…' : 'Wire'}
        </button>
      </div>
    </Modal>
  );
}

function EditEntryModal({
  entry,
  onClose,
  onDone,
}: {
  entry: RegisteredAgent;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(entry.name);
  const [trigger, setTrigger] = useState(entry.trigger);
  const [primary, setPrimary] = useState(!!entry.primary);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await api.updateAgentEntry({
        jid: entry.jid,
        name,
        trigger,
        primary,
      });
      onDone();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Edit ${entry.jid}`} onClose={onClose}>
      <div className="text-xs text-[color:var(--muted)]">
        folder={entry.folder}
      </div>
      <Field label="Name on this channel">
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Trigger on this channel">
        <input
          className={inputCls}
          value={trigger}
          onChange={(e) => setTrigger(e.target.value)}
        />
      </Field>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={primary}
          onChange={(e) => setPrimary(e.target.checked)}
        />
        primary channel
      </label>
      {err && <div className="text-xs text-red-500">{err}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onClose}
          className="text-xs px-3 py-1.5 rounded-md border border-[color:var(--border)]"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded-md bg-[color:var(--accent)] text-white disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

function DeleteAgentModal({
  group,
  onClose,
  onDone,
}: {
  group: AgentGroup;
  onClose: () => void;
  onDone: () => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [deleteVar, setDeleteVar] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (confirmText !== group.folder) {
      setErr(`type "${group.folder}" to confirm`);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.deleteAgent(group.folder, { deleteFiles, deleteVar });
      onDone();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Delete agent: ${group.folder}`} onClose={onClose}>
      <div className="text-xs text-[color:var(--muted)] space-y-1">
        <div>
          Unwires {group.entries.length} channel
          {group.entries.length === 1 ? '' : 's'}:
        </div>
        <ul className="space-y-0.5 pl-2">
          {group.entries.map((e) => (
            <li key={e.jid}>
              <code className="text-[10px]">{e.jid}</code>
            </li>
          ))}
        </ul>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={deleteFiles}
          onChange={(e) => setDeleteFiles(e.target.checked)}
        />
        also delete ~/.nanoclaw/agents/{group.folder}/
      </label>
      {deleteFiles && (
        <label className="flex items-center gap-2 text-xs pl-5">
          <input
            type="checkbox"
            checked={deleteVar}
            onChange={(e) => setDeleteVar(e.target.checked)}
          />
          also wipe var/agents/{group.folder}/ (transcripts, heartbeat log)
        </label>
      )}
      <Field label={`type "${group.folder}" to confirm`}>
        <input
          className={inputCls}
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
        />
      </Field>
      {err && <div className="text-xs text-red-500">{err}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onClose}
          className="text-xs px-3 py-1.5 rounded-md border border-[color:var(--border)]"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={busy || confirmText !== group.folder}
          className="text-xs px-3 py-1.5 rounded-md bg-red-500 text-white disabled:opacity-40"
        >
          {busy ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </Modal>
  );
}
