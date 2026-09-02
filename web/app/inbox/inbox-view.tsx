'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { api, type WorkflowWait } from '@/lib/api';
import { WaitControls } from '../workflows/[slug]/runs/[id]/run-view';
import { shortTime } from '../workflows/workflows-view';

export function InboxView() {
  const [waits, setWaits] = useState<WorkflowWait[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .waits()
      .then((r) => setWaits(r.waits))
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
    const es = new EventSource('/api/workflows/stream');
    es.onmessage = () => load();
    return () => es.close();
  }, [load]);

  if (error) return <p className="text-sm text-[#d05353]">{error}</p>;
  if (!waits)
    return <p className="text-sm text-[color:var(--muted)]">Loading…</p>;
  if (!waits.length)
    return (
      <p className="text-sm text-[color:var(--muted)]">
        Nothing is waiting on you.
      </p>
    );

  return (
    <div className="max-w-2xl mx-auto flex flex-col gap-2">
      {waits.map((w) => (
        <div
          key={w.id}
          className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-3 flex flex-col gap-1"
        >
          <div className="flex items-center gap-2 text-xs text-[color:var(--muted)]">
            <Link
              href={`/workflows/${encodeURIComponent(w.slug ?? '')}/runs/${w.runId}`}
              className="hover:underline"
            >
              {w.workflowName ?? w.slug} / {w.nodeId}
            </Link>
            <span>· asked {shortTime(w.createdAt)}</span>
            {w.targets?.length ? (
              <span>· for {w.targets.join(', ')}</span>
            ) : null}
          </div>
          <WaitControls wait={w} onDone={load} />
        </div>
      ))}
    </div>
  );
}
