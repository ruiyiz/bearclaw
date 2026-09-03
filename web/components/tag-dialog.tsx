'use client';

import { useEffect, useState } from 'react';

import { TagChip } from '@/components/tag-chip';
import { api, type WorkflowDefinition } from '@/lib/api';

// Filing a workflow shouldn't mean opening it: this edits the definition's
// tags in place from wherever the list is.
export function TagDialog({
  slug,
  name,
  suggestions,
  onClose,
  onSaved,
}: {
  slug: string;
  name: string;
  suggestions: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .workflow(slug)
      .then((r) => {
        setDefinition(r.definition);
        setTags(r.definition.tags ?? []);
      })
      .catch((e) => setError(String(e)));
  }, [slug]);

  const add = (raw: string) => {
    const clean = raw.trim().toLowerCase().replace(/^#/, '');
    setDraft('');
    if (!clean || tags.includes(clean) || tags.length >= 12) return;
    setTags((prev) => [...prev, clean]);
  };

  const save = async () => {
    if (!definition) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveWorkflow(slug, { ...definition, tags });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const unused = suggestions.filter((s) => !tags.includes(s));

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[16vh]"
      onClick={onClose}
    >
      <div
        className="w-[min(420px,92vw)] overflow-hidden rounded-xl border border-[color:var(--border)] bg-[color:var(--card)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-[color:var(--border)] px-4 py-3 text-[13px] font-semibold">
          Tags ·{' '}
          <span className="font-normal text-[color:var(--muted)]">{name}</span>
        </div>
        <div className="flex flex-col gap-3 px-4 py-4">
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <TagChip
                key={tag}
                tag={tag}
                onRemove={() =>
                  setTags((prev) => prev.filter((x) => x !== tag))
                }
              />
            ))}
            {tags.length === 0 && (
              <span className="text-[11.5px] text-[color:var(--muted)]">
                No tags yet.
              </span>
            )}
          </div>
          <input
            autoFocus
            value={draft}
            placeholder={
              tags.length >= 12 ? 'twelve is the limit' : 'add a tag…'
            }
            disabled={!definition || tags.length >= 12}
            onChange={(e) => {
              const v = e.target.value;
              if (v.endsWith(',')) add(v.slice(0, -1));
              else setDraft(v);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add(draft);
              if (e.key === 'Escape') onClose();
              if (e.key === 'Backspace' && !draft && tags.length)
                setTags((prev) => prev.slice(0, -1));
            }}
            className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-[color:var(--accent)] disabled:opacity-50"
          />
          {unused.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-[color:var(--muted)]">
                in use:
              </span>
              {unused.map((tag) => (
                <TagChip
                  key={tag}
                  tag={tag}
                  size="xs"
                  onClick={() => add(tag)}
                />
              ))}
            </div>
          )}
          {error && (
            <p className="text-[11.5px] text-[color:var(--danger)]">{error}</p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-[color:var(--border)] px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[color:var(--border)] px-3 py-1.5 text-[12px] text-[color:var(--muted)] hover:text-[color:var(--fg)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!definition || busy}
            onClick={save}
            className="rounded-md bg-[color:var(--accent)] px-3 py-1.5 text-[12px] font-semibold text-[color:var(--on-accent)] disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save tags'}
          </button>
        </div>
      </div>
    </div>
  );
}
