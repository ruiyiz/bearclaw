'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { PageHeader } from '@/components/page-header';
import { api, type WorkflowTrigger } from '@/lib/api';
import { shortTime } from '@/lib/format';

// Every trigger across every workflow, soonest first. This is the "all
// workflows, scheduled or otherwise" view.
export function SchedulesView() {
  const [rows, setRows] = useState<WorkflowTrigger[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .triggers()
      .then((r) =>
        setRows(
          [...r.triggers].sort((a, b) =>
            (a.nextRunAt ?? '9999').localeCompare(b.nextRunAt ?? '9999'),
          ),
        ),
      )
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
    const es = new EventSource('/api/workflows/stream');
    es.onmessage = () => load();
    return () => es.close();
  }, [load]);

  if (error) return <p className="text-sm text-[#d05353]">{error}</p>;
  if (!rows)
    return <p className="text-sm text-[color:var(--muted)]">Loading…</p>;
  if (!rows.length)
    return <p className="text-sm text-[color:var(--muted)]">No triggers.</p>;

  return (
    <>
      <PageHeader title="Schedules" subtitle="every trigger, soonest first" />
      <div className="max-w-3xl mx-auto flex flex-col gap-1">
        {rows.map((t) => (
          <div
            key={t.id}
            className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-2 flex items-start gap-2"
          >
            <div className="min-w-0 flex-1">
              <Link
                href={`/workflows/${encodeURIComponent(t.slug)}`}
                className="text-sm hover:underline"
              >
                {t.slug}
              </Link>
              <div className="text-xs text-[color:var(--muted)]">
                {t.type} · {t.source}
                {t.enabled ? '' : ' · paused'} · next {shortTime(t.nextRunAt)}
              </div>
              <div className="text-xs text-[color:var(--muted)] break-all">
                {JSON.stringify(t.config)}
              </div>
            </div>
            <div className="flex gap-1 shrink-0">
              <button
                onClick={async () => {
                  await api.runWorkflow(t.slug, t.args);
                  load();
                }}
                className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:bg-[color:var(--bg)]"
              >
                Run now
              </button>
              <button
                onClick={async () => {
                  await api.updateTrigger(t.id, { enabled: !t.enabled });
                  load();
                }}
                className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:bg-[color:var(--bg)]"
              >
                {t.enabled ? 'Pause' : 'Resume'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
