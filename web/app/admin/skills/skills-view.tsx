'use client';
import { useEffect, useState } from 'react';
import { api, type SkillInfo, type SkillSource } from '@/lib/api';

export function SkillsView() {
  const [installed, setInstalled] = useState<SkillInfo[]>([]);
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [available, setAvailable] = useState<Record<string, SkillInfo[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [newSrc, setNewSrc] = useState('');

  function reload() {
    void api.skills().then((d) => setInstalled(d.skills));
    void api.skillSources().then(async (d) => {
      setSources(d.sources);
      const next: Record<string, SkillInfo[]> = {};
      await Promise.all(
        d.sources.map(async (s) => {
          const r = await api
            .skillsAvailable(s.dir)
            .catch(() => ({ skills: [] }));
          next[s.dir] = r.skills;
        }),
      );
      setAvailable(next);
    });
  }

  useEffect(reload, []);

  async function install(s: SkillInfo) {
    setBusy(s.path);
    try {
      await api.installSkill(s.path, s.name);
      reload();
    } finally {
      setBusy(null);
    }
  }
  async function uninstall(s: SkillInfo) {
    setBusy(s.name);
    try {
      await api.uninstallSkill(s.name);
      reload();
    } finally {
      setBusy(null);
    }
  }
  async function sync() {
    setBusy('sync');
    try {
      await api.syncSkills();
      reload();
    } finally {
      setBusy(null);
    }
  }
  async function addSource() {
    if (!newSrc.trim()) return;
    setBusy('addSource');
    try {
      await api.addSkillSource(newSrc.trim());
      setNewSrc('');
      reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <header className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Installed</h2>
          <button
            onClick={sync}
            disabled={busy === 'sync'}
            className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-1.5 text-sm hover:border-[color:var(--accent)] disabled:opacity-40"
          >
            {busy === 'sync' ? 'Syncing…' : 'Sync from sources'}
          </button>
        </header>
        <ul className="space-y-2">
          {installed.map((s) => (
            <li
              key={s.name}
              className="flex items-start justify-between gap-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-2"
            >
              <div>
                <div className="text-sm font-medium">{s.name}</div>
                <div className="text-xs text-[color:var(--muted)]">
                  {s.description}
                </div>
              </div>
              <button
                onClick={() => uninstall(s)}
                disabled={busy === s.name}
                className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:border-red-500 hover:text-red-500 disabled:opacity-40"
              >
                Remove
              </button>
            </li>
          ))}
          {installed.length === 0 && (
            <li className="text-sm text-[color:var(--muted)]">
              None installed.
            </li>
          )}
        </ul>
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Sources</h2>
        <div className="flex gap-2">
          <input
            value={newSrc}
            onChange={(e) => setNewSrc(e.target.value)}
            placeholder="/abs/path/to/skill/dir"
            className="flex-1 bg-[color:var(--card)] border border-[color:var(--border)] rounded-md px-3 py-2 text-sm"
          />
          <button
            onClick={addSource}
            disabled={busy === 'addSource' || !newSrc.trim()}
            className="rounded-md bg-[color:var(--accent)] text-white px-3 text-sm disabled:opacity-40"
          >
            Add
          </button>
        </div>
        {sources.map((s) => (
          <div key={s.dir} className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-[color:var(--muted)]">
              {s.label} {s.builtin && '(builtin)'} — {s.dir}
            </div>
            <ul className="space-y-2">
              {(available[s.dir] || []).map((sk) => (
                <li
                  key={sk.path}
                  className="flex items-start justify-between gap-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-2"
                >
                  <div>
                    <div className="text-sm font-medium">{sk.name}</div>
                    <div className="text-xs text-[color:var(--muted)]">
                      {sk.description}
                    </div>
                  </div>
                  <button
                    onClick={() => install(sk)}
                    disabled={busy === sk.path}
                    className="text-xs px-2 py-1 rounded-md bg-[color:var(--accent)] text-white disabled:opacity-40"
                  >
                    Install
                  </button>
                </li>
              ))}
              {(available[s.dir] || []).length === 0 && (
                <li className="text-sm text-[color:var(--muted)]">
                  All installed.
                </li>
              )}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}
