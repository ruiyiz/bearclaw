'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { EditorView } from '@codemirror/view';
import {
  api,
  type SkillFileContent,
  type SkillFileInfo,
  type SkillInfo,
  type SkillSource,
} from '@/lib/api';
import { useConfirm } from '@/components/confirm-dialog';
import { useResolvedTheme } from '@/lib/editor';

export function SkillsView() {
  const [installed, setInstalled] = useState<SkillInfo[]>([]);
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [available, setAvailable] = useState<Record<string, SkillInfo[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [newSrc, setNewSrc] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

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
              <div className="min-w-0">
                <div className="text-sm font-medium">{s.name}</div>
                <div className="text-xs text-[color:var(--muted)]">
                  {s.description}
                </div>
                {expanded === s.name && <SkillFiles name={s.name} />}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() =>
                    setExpanded(expanded === s.name ? null : s.name)
                  }
                  className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:border-[color:var(--accent)]"
                >
                  {expanded === s.name ? 'Hide files' : 'Files'}
                </button>
                <button
                  onClick={() => uninstall(s)}
                  disabled={busy === s.name}
                  className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:border-red-500 hover:text-red-500 disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
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

// Per-skill file browser. Files are rows in the config database; saving here
// rewrites the row and regenerates the mirror the agent reads.
function SkillFiles({ name }: { name: string }) {
  const confirm = useConfirm();
  const theme = useResolvedTheme();
  const [files, setFiles] = useState<SkillFileInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<SkillFileContent | null>(null);
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    const d = await api.skillFiles(name);
    setFiles(d.files);
  }, [name]);

  useEffect(() => {
    void reload().catch((e: Error) => setError(String(e)));
  }, [reload]);

  useEffect(() => {
    if (!selected) return;
    setError(null);
    setStatus(null);
    api
      .skillFileRead(name, selected)
      .then((d) => {
        setFile(d);
        setContent(d.content);
        setOriginal(d.content);
      })
      .catch((e: Error) => setError(String(e)));
  }, [name, selected]);

  const dirty = !!file && !file.binary && content !== original;

  async function save() {
    if (!selected || !dirty) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await api.skillFileWrite(name, selected, content);
      setOriginal(content);
      setStatus('Saved');
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!selected) return;
    const ok = await confirm({
      title: 'Delete file',
      message: `Delete ${name}/${selected}? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.skillFileDelete(name, selected);
      setSelected(null);
      setFile(null);
      setContent('');
      setOriginal('');
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  const extensions = useMemo(
    () =>
      selected?.endsWith('.md')
        ? [
            markdown({ base: markdownLanguage, codeLanguages: languages }),
            EditorView.lineWrapping,
          ]
        : [EditorView.lineWrapping],
    [selected],
  );

  return (
    <div className="mt-2 space-y-2 border-t border-[color:var(--border)] pt-2">
      <div className="flex flex-wrap gap-1">
        {files.map((f) => (
          <button
            key={f.relpath}
            onClick={() =>
              setSelected(selected === f.relpath ? null : f.relpath)
            }
            title={`${f.size} bytes, mode ${f.mode.toString(8)}`}
            className={`text-xs px-2 py-0.5 rounded-md border ${
              selected === f.relpath
                ? 'border-[color:var(--accent)] text-[color:var(--fg)]'
                : 'border-[color:var(--border)] text-[color:var(--muted)] hover:text-[color:var(--fg)]'
            }`}
          >
            {f.relpath}
          </button>
        ))}
        {files.length === 0 && (
          <span className="text-xs text-[color:var(--muted)]">No files.</span>
        )}
      </div>

      {error && <div className="text-xs text-red-500">{error}</div>}

      {selected && file && (
        <div className="rounded-md border border-[color:var(--border)] overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-[color:var(--border)]">
            <div className="text-xs text-[color:var(--muted)] truncate">
              {selected} · mode {file.mode.toString(8)} · {file.size} bytes
              {dirty && (
                <span className="ml-2 text-[color:var(--accent)]">
                  • unsaved
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {status && (
                <span className="text-xs text-[color:var(--muted)]">
                  {status}
                </span>
              )}
              <button
                onClick={remove}
                className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:border-red-500 hover:text-red-500"
              >
                Delete
              </button>
              <button
                onClick={save}
                disabled={!dirty || saving}
                className="text-xs px-2 py-1 rounded-md bg-[color:var(--accent)] text-white disabled:opacity-40"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
          {file.binary ? (
            <div className="p-2 text-xs text-[color:var(--muted)]">
              Binary or oversized file — not editable here.
            </div>
          ) : (
            <div className="code-surface max-h-96 overflow-auto">
              <CodeMirror
                value={content}
                onChange={setContent}
                extensions={extensions}
                theme={theme}
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: false,
                  highlightActiveLine: true,
                }}
                style={{ fontSize: 13 }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
