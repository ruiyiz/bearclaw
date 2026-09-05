'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type InstallConfig,
  type McpServer,
  type SettingRow,
} from '@/lib/api';
import { useConfirm } from '@/components/confirm-dialog';

const inputClass =
  'w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2.5 py-1.5 text-sm focus:border-[color:var(--accent)] focus:outline-none';

export function SettingsView() {
  const confirm = useConfirm();
  const [settings, setSettings] = useState<SettingRow[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [install, setInstall] = useState<InstallConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirtyRestart, setDirtyRestart] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([api.settingsList(), api.mcpList()]);
      setSettings(s.settings);
      setServers(m.servers);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    api
      .installConfig()
      .then(setInstall)
      .catch(() => {});
  }, [reload]);

  async function run(fn: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      setDirtyRestart(true);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function restart() {
    setError(null);
    setBusy(true);
    try {
      await api.restart();
      setDirtyRestart(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {dirtyRestart && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-[color:var(--accent)] bg-[color:var(--card)] px-4 py-3">
          <div className="text-sm">
            BearClaw reads these values at startup. Restart to apply them.
          </div>
          <button
            onClick={() => void restart()}
            disabled={busy}
            className="shrink-0 rounded-md bg-[color:var(--accent)] px-3 py-1.5 text-xs text-white disabled:opacity-40"
          >
            Restart now
          </button>
        </div>
      )}

      {error && <div className="text-sm text-red-500">{error}</div>}

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Settings</h2>
        <div className="overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]">
          {settings.length === 0 && (
            <div className="px-4 py-3 text-sm text-[color:var(--muted)]">
              Nothing configured yet.
            </div>
          )}
          {settings.map((row) => (
            <SettingRowView
              key={row.key}
              row={row}
              busy={busy}
              onSave={(value) =>
                run(async () => {
                  await api.settingsPut({ [row.key]: value });
                })
              }
              onDelete={async () => {
                const ok = await confirm({
                  title: 'Delete setting',
                  message: `Remove ${row.key}?`,
                  confirmLabel: 'Delete',
                  danger: true,
                });
                if (!ok) return;
                await run(async () => {
                  await api.settingsPut({ [row.key]: null });
                });
              }}
            />
          ))}
        </div>
        <AddSetting
          busy={busy}
          onAdd={(key, value, secret) =>
            run(async () => {
              await api.settingsPut(
                { [key]: value },
                secret ? [key] : undefined,
              );
            })
          }
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">MCP servers</h2>
        <div className="space-y-3">
          {servers.length === 0 && (
            <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] px-4 py-3 text-sm text-[color:var(--muted)]">
              No MCP servers configured.
            </div>
          )}
          {servers.map((s) => (
            <McpServerView
              key={s.name}
              server={s}
              busy={busy}
              onSave={(config, enabled) =>
                run(async () => {
                  await api.mcpPut(s.name, config, enabled);
                })
              }
              onDelete={async () => {
                const ok = await confirm({
                  title: 'Delete MCP server',
                  message: `Remove ${s.name}?`,
                  confirmLabel: 'Delete',
                  danger: true,
                });
                if (!ok) return;
                await run(async () => {
                  await api.mcpDelete(s.name);
                });
              }}
            />
          ))}
        </div>
        <AddMcpServer
          busy={busy}
          onAdd={(name, config) =>
            run(async () => {
              await api.mcpPut(name, config, true);
            })
          }
        />
      </section>

      {install && (
        <section className="space-y-1 text-xs text-[color:var(--muted)]">
          <div>Home: {install.home}</div>
          <div>Config database: {install.configDb ?? 'not open'}</div>
          <div>Var: {install.varDir}</div>
        </section>
      )}
    </div>
  );
}

function SettingRowView({
  row,
  busy,
  onSave,
  onDelete,
}: {
  row: SettingRow;
  busy: boolean;
  onSave: (value: string) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);

  return (
    <div className="flex flex-col gap-2 border-b border-[color:var(--border)] px-4 py-3 last:border-b-0 sm:flex-row sm:items-center">
      <div className="min-w-0 sm:w-64">
        <div className="truncate font-mono text-sm">{row.key}</div>
        <div className="text-xs text-[color:var(--muted)]">
          {row.secret ? 'secret' : 'plain'} · updated{' '}
          {new Date(row.updatedAt).toLocaleDateString()}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            type={row.secret ? 'password' : 'text'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="New value"
            className={inputClass}
          />
        ) : (
          <div className="truncate font-mono text-sm text-[color:var(--muted)]">
            {row.value || '(empty)'}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {editing ? (
          <>
            <button
              onClick={() => {
                setEditing(false);
                void onSave(value);
                setValue('');
              }}
              disabled={busy || !value}
              className="rounded-md bg-[color:var(--accent)] px-3 py-1.5 text-xs text-white disabled:opacity-40"
            >
              Save
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setValue('');
              }}
              className="rounded-md border border-[color:var(--border)] px-3 py-1.5 text-xs"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setEditing(true)}
              disabled={busy}
              className="rounded-md border border-[color:var(--border)] px-3 py-1.5 text-xs disabled:opacity-40"
            >
              Set new value
            </button>
            <button
              onClick={() => void onDelete()}
              disabled={busy}
              className="rounded-md border border-[color:var(--border)] px-3 py-1.5 text-xs hover:border-red-500 hover:text-red-500 disabled:opacity-40"
            >
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function AddSetting({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (key: string, value: string, secret: boolean) => void | Promise<void>;
}) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [secret, setSecret] = useState(false);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!key.trim() || !value) return;
        void onAdd(key.trim(), value, secret);
        setKey('');
        setValue('');
        setSecret(false);
      }}
      className="flex flex-col gap-2 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] px-4 py-3 sm:flex-row sm:items-center"
    >
      <input
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="KEY_NAME"
        className={`${inputClass} sm:w-64`}
      />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        type={secret ? 'password' : 'text'}
        placeholder="Value"
        className={inputClass}
      />
      <label className="flex shrink-0 items-center gap-1.5 text-xs text-[color:var(--muted)]">
        <input
          type="checkbox"
          checked={secret}
          onChange={(e) => setSecret(e.target.checked)}
        />
        Secret
      </label>
      <button
        type="submit"
        disabled={busy || !key.trim() || !value}
        className="shrink-0 rounded-md bg-[color:var(--accent)] px-3 py-1.5 text-xs text-white disabled:opacity-40"
      >
        Add
      </button>
    </form>
  );
}

function McpServerView({
  server,
  busy,
  onSave,
  onDelete,
}: {
  server: McpServer;
  busy: boolean;
  onSave: (
    config: Record<string, unknown>,
    enabled: boolean,
  ) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}) {
  const [text, setText] = useState(() =>
    JSON.stringify(server.config, null, 2),
  );
  const [enabled, setEnabled] = useState(server.enabled);
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    setText(JSON.stringify(server.config, null, 2));
    setEnabled(server.enabled);
  }, [server]);

  function save() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setParseError(String(e));
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setParseError('Config must be a JSON object.');
      return;
    }
    setParseError(null);
    void onSave(parsed as Record<string, unknown>, enabled);
  }

  return (
    <div className="space-y-2 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="font-mono text-sm">{server.name}</div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-[color:var(--muted)]">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>
          <button
            onClick={save}
            disabled={busy}
            className="rounded-md bg-[color:var(--accent)] px-3 py-1.5 text-xs text-white disabled:opacity-40"
          >
            Save
          </button>
          <button
            onClick={() => void onDelete()}
            disabled={busy}
            className="rounded-md border border-[color:var(--border)] px-3 py-1.5 text-xs hover:border-red-500 hover:text-red-500 disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={Math.min(16, text.split('\n').length + 1)}
        className={`${inputClass} font-mono text-xs`}
      />
      {parseError && <div className="text-xs text-red-500">{parseError}</div>}
    </div>
  );
}

function AddMcpServer({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (
    name: string,
    config: Record<string, unknown>,
  ) => void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [text, setText] = useState('{\n  "command": "npx",\n  "args": []\n}');
  const [parseError, setParseError] = useState<string | null>(null);

  return (
    <div className="space-y-2 rounded-lg border border-dashed border-[color:var(--border)] px-4 py-3">
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="server-name"
          className={`${inputClass} sm:w-64`}
        />
        <button
          onClick={() => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch (e) {
              setParseError(String(e));
              return;
            }
            if (
              !parsed ||
              typeof parsed !== 'object' ||
              Array.isArray(parsed)
            ) {
              setParseError('Config must be a JSON object.');
              return;
            }
            setParseError(null);
            void onAdd(name.trim(), parsed as Record<string, unknown>);
            setName('');
          }}
          disabled={busy || !name.trim()}
          className="shrink-0 rounded-md bg-[color:var(--accent)] px-3 py-1.5 text-xs text-white disabled:opacity-40"
        >
          Add server
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={6}
        className={`${inputClass} font-mono text-xs`}
      />
      {parseError && <div className="text-xs text-red-500">{parseError}</div>}
    </div>
  );
}
