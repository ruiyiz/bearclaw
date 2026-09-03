'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import { api, type WorkflowSummary } from '@/lib/api';

interface Entry {
  label: string;
  hint: string;
  href: string;
}

const MODULES: Entry[] = [
  { label: 'Chat', hint: 'module', href: '/chat' },
  { label: 'Workflows', hint: 'module', href: '/workflows' },
  { label: 'Schedules', hint: 'module', href: '/workflows/schedules' },
  { label: 'Events', hint: 'module', href: '/workflows/events' },
  { label: 'Admin · Health', hint: 'module', href: '/admin/health' },
  { label: 'Admin · Agents', hint: 'module', href: '/admin/agents' },
  { label: 'Admin · Skills', hint: 'module', href: '/admin/skills' },
  { label: 'Admin · Context', hint: 'module', href: '/admin/context' },
];

// Search is a jump, not a query language: the modules plus every workflow, by
// name or slug, opened with the keyboard.
export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<WorkflowSummary[]>([]);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    input.current?.focus();
    api
      .workflows()
      .then((r) => setRows(r.workflows))
      .catch(() => {});
  }, [open]);

  const entries = useMemo(() => {
    const all: Entry[] = [
      ...MODULES,
      ...rows.map((w) => ({
        label: w.name,
        hint: `${w.slug} · ${w.owner}`,
        href: `/workflows/${encodeURIComponent(w.slug)}`,
      })),
    ];
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, 12);
    return all
      .filter(
        (e) =>
          e.label.toLowerCase().includes(q) || e.hint.toLowerCase().includes(q),
      )
      .slice(0, 12);
  }, [rows, query]);

  if (!open) return null;

  const go = (entry: Entry | undefined) => {
    if (!entry) return;
    onClose();
    router.push(entry.href);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="w-[min(560px,92vw)] overflow-hidden rounded-xl border border-[color:var(--border)] bg-[color:var(--card)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={input}
          value={query}
          placeholder="Jump to a workflow or a module…"
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown')
              setCursor((c) => Math.min(c + 1, entries.length - 1));
            if (e.key === 'ArrowUp') setCursor((c) => Math.max(c - 1, 0));
            if (e.key === 'Enter') go(entries[cursor]);
          }}
          className="w-full border-b border-[color:var(--border)] bg-transparent px-4 py-3 text-[14px] outline-none"
        />
        <ul className="max-h-[52vh] overflow-y-auto py-1">
          {entries.length === 0 && (
            <li className="px-4 py-3 text-[12.5px] text-[color:var(--muted)]">
              Nothing matches.
            </li>
          )}
          {entries.map((e, i) => (
            <li key={e.href + e.label}>
              <button
                type="button"
                onMouseEnter={() => setCursor(i)}
                onClick={() => go(e)}
                className="flex w-full items-baseline gap-3 px-4 py-2 text-left"
                style={{
                  background: i === cursor ? 'var(--bg-2)' : 'transparent',
                }}
              >
                <span className="truncate text-[13px]">{e.label}</span>
                <span className="truncate font-mono text-[11px] text-[color:var(--muted)]">
                  {e.hint}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
