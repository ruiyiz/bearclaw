'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { EditorView } from '@codemirror/view';
import {
  api,
  type ContextFile,
  type ContextListing,
  type ContextScope,
} from '@/lib/api';

type Selection = { scope: ContextScope; folder: string | null; name: string };

function sameSel(a: Selection | null, b: Selection | null): boolean {
  if (!a || !b) return a === b;
  return a.scope === b.scope && a.folder === b.folder && a.name === b.name;
}

function useTheme(): 'dark' | 'light' {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  useEffect(() => {
    const compute = (): 'dark' | 'light' => {
      const attr = document.documentElement.getAttribute('data-theme');
      if (attr === 'dark' || attr === 'light') return attr;
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    };
    setTheme(compute());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onMq = () => setTheme(compute());
    mq.addEventListener('change', onMq);
    const obs = new MutationObserver(() => setTheme(compute()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      mq.removeEventListener('change', onMq);
      obs.disconnect();
    };
  }, []);
  return theme;
}

export function ContextView() {
  const [listing, setListing] = useState<ContextListing | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [content, setContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [modifiedAt, setModifiedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const theme = useTheme();

  const reload = useCallback(async () => {
    const d = await api.contextList();
    setListing(d);
    if (!selected) {
      const first =
        d.shared[0] || d.agents.find((a) => a.files.length)?.files[0];
      if (first) {
        setSelected({
          scope: first.scope,
          folder: first.folder,
          name: first.name,
        });
      }
    }
  }, [selected]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    setStatus(null);
    api
      .contextRead(selected.scope, selected.folder, selected.name)
      .then((d) => {
        setContent(d.content);
        setOriginalContent(d.content);
        setModifiedAt(d.modifiedAt);
      })
      .catch((e: Error) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [selected]);

  const dirty = content !== originalContent;

  async function save() {
    if (!selected || !dirty) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const r = await api.contextWrite(
        selected.scope,
        selected.folder,
        selected.name,
        content,
      );
      setOriginalContent(content);
      setModifiedAt(r.modifiedAt);
      setStatus('Saved');
      void reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function createFile(scope: ContextScope, folder: string | null) {
    const label = scope === 'shared' ? 'shared' : folder;
    const input = window.prompt(
      `New markdown file in ${label}/ (e.g. NOTES.md):`,
    );
    if (!input) return;
    let name = input.trim();
    if (!name) return;
    if (!name.toLowerCase().endsWith('.md')) name += '.md';
    if (!/^[A-Za-z0-9._-]+\.md$/.test(name)) {
      setError(
        'Invalid filename. Use letters, digits, dot, underscore, dash; must end in .md',
      );
      return;
    }
    setError(null);
    setStatus(null);
    try {
      await api.contextCreate(scope, folder, name, '');
      await reload();
      setSelected({ scope, folder, name });
    } catch (e) {
      setError(String(e));
    }
  }

  async function deleteFile() {
    if (!selected) return;
    const label = selected.scope === 'shared' ? 'shared' : selected.folder;
    if (
      !window.confirm(
        `Delete ${label}/${selected.name}? This cannot be undone.`,
      )
    )
      return;
    setError(null);
    setStatus(null);
    try {
      await api.contextDelete(selected.scope, selected.folder, selected.name);
      setSelected(null);
      setContent('');
      setOriginalContent('');
      setModifiedAt(null);
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  // Cmd/Ctrl+S to save inside the editor.
  const saveKeymap = useMemo(
    () =>
      EditorView.domEventHandlers({
        keydown(ev) {
          if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
            ev.preventDefault();
            void save();
            return true;
          }
          return false;
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content, originalContent, selected],
  );

  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      saveKeymap,
    ],
    [saveKeymap],
  );

  return (
    <div className="flex flex-col lg:flex-row gap-3 h-[calc(100vh-6rem)]">
      <aside className="lg:w-72 shrink-0 overflow-y-auto rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-2 space-y-3">
        <FileGroup
          title="Shared"
          files={listing?.shared ?? []}
          selected={selected}
          onSelect={setSelected}
          onCreate={() => createFile('shared', null)}
        />
        {(listing?.agents ?? []).map((a) => (
          <FileGroup
            key={a.folder}
            title={a.folder}
            files={a.files}
            selected={selected}
            onSelect={setSelected}
            onCreate={() => createFile('agent', a.folder)}
          />
        ))}
        {listing &&
          listing.shared.length === 0 &&
          listing.agents.length === 0 && (
            <div className="text-sm text-[color:var(--muted)] px-2 py-1">
              No context files found.
            </div>
          )}
      </aside>

      <section className="flex-1 min-w-0 flex flex-col rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] overflow-hidden">
        <header className="flex items-center justify-between gap-3 px-3 py-2 border-b border-[color:var(--border)]">
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">
              {selected
                ? `${selected.scope === 'shared' ? 'shared' : selected.folder}/${selected.name}`
                : 'No file selected'}
            </div>
            <div className="text-xs text-[color:var(--muted)]">
              {modifiedAt
                ? `Modified ${new Date(modifiedAt).toLocaleString()}`
                : ''}
              {dirty && (
                <span className="ml-2 text-[color:var(--accent)]">
                  • unsaved
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {status && (
              <span className="text-xs text-[color:var(--muted)]">
                {status}
              </span>
            )}
            {error && (
              <span className="text-xs text-red-500 max-w-xs truncate">
                {error}
              </span>
            )}
            <button
              onClick={deleteFile}
              disabled={!selected || saving}
              className="text-xs px-3 py-1.5 rounded-md border border-[color:var(--border)] hover:border-red-500 hover:text-red-500 disabled:opacity-40"
            >
              Delete
            </button>
            <button
              onClick={save}
              disabled={!selected || !dirty || saving}
              className="text-xs px-3 py-1.5 rounded-md bg-[color:var(--accent)] text-white disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </header>

        <div className="flex-1 min-h-0 overflow-auto">
          {loading ? (
            <div className="p-3 text-sm text-[color:var(--muted)]">
              Loading…
            </div>
          ) : selected ? (
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
              style={{ fontSize: 14 }}
            />
          ) : (
            <div className="p-3 text-sm text-[color:var(--muted)]">
              Select a file to edit.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function FileGroup({
  title,
  files,
  selected,
  onSelect,
  onCreate,
}: {
  title: string;
  files: ContextFile[];
  selected: Selection | null;
  onSelect: (s: Selection) => void;
  onCreate: () => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between px-2 py-1">
        <div className="text-xs uppercase tracking-wide text-[color:var(--muted)]">
          {title}
        </div>
        <button
          onClick={onCreate}
          title={`New file in ${title}`}
          className="text-xs leading-none px-1.5 py-0.5 rounded border border-[color:var(--border)] text-[color:var(--muted)] hover:text-[color:var(--fg)] hover:border-[color:var(--accent)]"
        >
          +
        </button>
      </div>
      <ul className="space-y-0.5">
        {files.map((f) => {
          const sel: Selection = {
            scope: f.scope,
            folder: f.folder,
            name: f.name,
          };
          const active = sameSel(selected, sel);
          return (
            <li key={`${f.scope}:${f.folder ?? ''}:${f.name}`}>
              <button
                onClick={() => onSelect(sel)}
                className={`w-full text-left text-sm px-2 py-1 rounded-md ${
                  active
                    ? 'bg-[color:var(--bg-2)] text-[color:var(--fg)]'
                    : 'hover:bg-[color:var(--bg-2)] text-[color:var(--fg)]/80'
                }`}
              >
                {f.name}
              </button>
            </li>
          );
        })}
        {files.length === 0 && (
          <li className="text-xs text-[color:var(--muted)] px-2 py-1">
            (empty)
          </li>
        )}
      </ul>
    </div>
  );
}
