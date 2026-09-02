'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { api, type WorkflowSummary } from '@/lib/api';

export function statusColor(status: string | null): string {
  switch (status) {
    case 'succeeded':
      return 'text-[#3fa06b]';
    case 'failed':
      return 'text-[#d05353]';
    case 'running':
      return 'text-[#4a8fd4]';
    case 'waiting':
      return 'text-[#d1a03a]';
    case 'cancelled':
      return 'text-[color:var(--muted)]';
    default:
      return 'text-[color:var(--muted)]';
  }
}

export function shortTime(iso: string | null): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 16);
}

export function WorkflowsView() {
  const [rows, setRows] = useState<WorkflowSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .workflows()
      .then((r) => setRows(r.workflows))
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
    const es = new EventSource('/api/workflows/stream');
    es.onmessage = () => load();
    return () => es.close();
  }, [load]);

  const run = async (slug: string) => {
    setBusy(slug);
    setError(null);
    try {
      await api.runWorkflow(slug);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (slug: string, enabled: boolean) => {
    await api.setWorkflowEnabled(slug, enabled);
    load();
  };

  if (error) return <p className="text-sm text-[#d05353]">{error}</p>;
  if (!rows)
    return <p className="text-sm text-[color:var(--muted)]">Loading…</p>;
  if (!rows.length)
    return (
      <p className="text-sm text-[color:var(--muted)]">
        No workflows yet. Definitions live in{' '}
        <code>~/.bearclaw/workflows/</code>.
      </p>
    );

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-2">
      {rows.map((w) => (
        <div
          key={w.slug}
          className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-3"
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <Link
                href={`/workflows/${encodeURIComponent(w.slug)}`}
                className="text-sm font-medium hover:underline"
              >
                {w.name}
              </Link>
              <div className="text-xs text-[color:var(--muted)] truncate">
                {w.slug} · {w.owner} · {w.nodeCount} nodes
                {w.enabled ? '' : ' · paused'}
              </div>
              <div className="text-xs text-[color:var(--muted)] mt-1">
                {w.triggers.length
                  ? w.triggers
                      .map((t) => `${t.type}${t.enabled ? '' : ' (paused)'}`)
                      .join(', ')
                  : 'no triggers'}
                {w.nextRunAt ? ` · next ${shortTime(w.nextRunAt)}` : ''}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              <span className={`text-xs ${statusColor(w.lastStatus)}`}>
                {w.lastStatus ?? 'never run'}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => run(w.slug)}
                  disabled={busy === w.slug}
                  className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:bg-[color:var(--bg)] disabled:opacity-50"
                >
                  {busy === w.slug ? 'Running…' : 'Run now'}
                </button>
                <button
                  onClick={() => toggle(w.slug, !w.enabled)}
                  className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:bg-[color:var(--bg)]"
                >
                  {w.enabled ? 'Pause' : 'Resume'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
