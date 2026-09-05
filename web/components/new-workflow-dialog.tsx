'use client';

import { useEffect, useState } from 'react';

import { api } from '@/lib/api';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

// A new workflow starts as one agent node, which is the smallest thing that
// both loads and does something. The graph editor takes it from there.
function starter(name: string, slug: string, owner: string) {
  return {
    name,
    slug,
    owner,
    nodes: {
      start: {
        type: 'agent',
        prompt: `Describe what ${name} should do, then wire the next node.`,
      },
    },
    edges: [],
  };
}

export function NewWorkflowDialog({
  open,
  onClose,
  onCreated,
  taken,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (slug: string) => void;
  taken: string[];
}) {
  const [mode, setMode] = useState<'blank' | 'import'>('blank');
  const [name, setName] = useState('');
  const [owner, setOwner] = useState('main');
  const [folders, setFolders] = useState<string[]>(['main']);
  const [imported, setImported] = useState('');
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode('blank');
    setName('');
    setImported('');
    setReplace(false);
    setError(null);
    api
      .agentFolders()
      .then((r) => {
        if (r.folders.length) {
          setFolders(r.folders);
          setOwner((o) => (r.folders.includes(o) ? o : r.folders[0]));
        }
      })
      .catch(() => {});
  }, [open]);

  if (!open) return null;

  const slug = slugify(name);
  const clash = taken.includes(slug);
  const valid = slug.length > 0 && !clash;

  const parsedImport = (() => {
    if (!imported.trim()) return null;
    try {
      const def = JSON.parse(imported) as { slug?: unknown };
      return typeof def.slug === 'string' && def.slug ? def : null;
    } catch {
      return null;
    }
  })();

  const create = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveWorkflow(slug, starter(name.trim(), slug, owner));
      onCreated(slug);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!parsedImport) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.importWorkflow(parsedImport, replace);
      onCreated(res.definition.slug);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const readFile = async (file: File) => {
    setError(null);
    setImported(await file.text());
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[16vh]"
      onClick={onClose}
    >
      <div
        className="w-[min(420px,92vw)] overflow-hidden rounded-xl border border-[color:var(--border)] bg-[color:var(--card)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[color:var(--border)] px-4 py-3">
          <span className="text-[13px] font-semibold">New workflow</span>
          <div className="flex gap-1.5">
            {(['blank', 'import'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                className="rounded-md border px-2 py-0.5 font-mono text-[11px]"
                style={{
                  borderColor: mode === m ? 'var(--accent)' : 'var(--border)',
                  color: mode === m ? 'var(--fg)' : 'var(--muted)',
                }}
              >
                {m === 'blank' ? 'blank' : 'import JSON'}
              </button>
            ))}
          </div>
        </div>
        {mode === 'import' ? (
          <div className="flex flex-col gap-3 px-4 py-4">
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void readFile(file);
              }}
              className="text-[12px] text-[color:var(--muted)]"
            />
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[10.5px] text-[color:var(--muted)]">
                or paste a definition
              </span>
              <textarea
                value={imported}
                rows={8}
                spellCheck={false}
                onChange={(e) => setImported(e.target.value)}
                placeholder='{ "slug": "digest", "name": "Digest", ... }'
                className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2.5 py-1.5 font-mono text-[11.5px] outline-none focus:border-[color:var(--accent)]"
              />
            </label>
            <label className="flex items-center gap-2 text-[11.5px] text-[color:var(--muted)]">
              <input
                type="checkbox"
                checked={replace}
                onChange={(e) => setReplace(e.target.checked)}
              />
              replace a workflow with the same slug
            </label>
            {imported.trim() && !parsedImport && (
              <p className="text-[11.5px] text-[color:var(--danger)]">
                Not a workflow definition: needs valid JSON with a slug.
              </p>
            )}
            {error && (
              <p className="text-[11.5px] text-[color:var(--danger)]">
                {error}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3 px-4 py-4">
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[10.5px] text-[color:var(--muted)]">
                name
              </span>
              <input
                autoFocus
                value={name}
                placeholder="Morning briefing"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void create();
                  if (e.key === 'Escape') onClose();
                }}
                className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[color:var(--accent)]"
              />
            </label>

            <div>
              <span className="mb-1.5 block font-mono text-[10.5px] text-[color:var(--muted)]">
                owner
              </span>
              <div className="flex flex-wrap gap-1.5">
                {folders.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setOwner(f)}
                    className="rounded-md border px-2 py-0.5 font-mono text-[11.5px]"
                    style={{
                      borderColor:
                        owner === f ? 'var(--accent)' : 'var(--border)',
                      color: owner === f ? 'var(--fg)' : 'var(--muted)',
                    }}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            <p className="font-mono text-[11px] text-[color:var(--muted)]">
              {slug ? `slug: ${slug}` : 'the name becomes the slug'}
            </p>
            {clash && (
              <p className="text-[11.5px] text-[color:var(--danger)]">
                {slug} already exists.
              </p>
            )}
            {error && (
              <p className="text-[11.5px] text-[color:var(--danger)]">
                {error}
              </p>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-[color:var(--border)] px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[color:var(--border)] px-3 py-1.5 text-[12px] text-[color:var(--muted)] hover:text-[color:var(--fg)]"
          >
            Cancel
          </button>
          {mode === 'import' ? (
            <button
              type="button"
              disabled={!parsedImport || busy}
              onClick={runImport}
              className="rounded-md bg-[color:var(--accent)] px-3 py-1.5 text-[12px] font-semibold text-[color:var(--on-accent)] disabled:opacity-50"
            >
              {busy ? 'Importing…' : 'Import'}
            </button>
          ) : (
            <button
              type="button"
              disabled={!valid || busy}
              onClick={create}
              className="rounded-md bg-[color:var(--accent)] px-3 py-1.5 text-[12px] font-semibold text-[color:var(--on-accent)] disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
