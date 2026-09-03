'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { PageHeader } from '@/components/page-header';
import { WorkflowCanvas, type NodeStatus } from '@/components/workflow-canvas';
import {
  api,
  type RunTimelineEntry,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowStep,
  type WorkflowWait,
} from '@/lib/api';
import { WaitControls } from '@/components/wait-controls';
import { shortTime } from '@/lib/format';

function toStatuses(steps: WorkflowStep[]): Record<string, NodeStatus> {
  const out: Record<string, NodeStatus> = {};
  for (const s of steps) out[s.nodeId] = s.status as NodeStatus;
  return out;
}

function took(step: WorkflowStep): string {
  if (!step.finishedAt) return '';
  const ms =
    new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const PILL: Record<
  string,
  { label: string; color: string; bg: string; border: string }
> = {
  waiting: {
    label: 'waiting on a person',
    color: 'var(--warn)',
    bg: 'var(--warn-bg)',
    border: 'var(--warn-border)',
  },
  running: {
    label: 'running',
    color: 'var(--accent)',
    bg: 'var(--accent-soft)',
    border: 'var(--accent)',
  },
  queued: {
    label: 'queued',
    color: 'var(--muted)',
    bg: 'var(--bg-2)',
    border: 'var(--border)',
  },
  succeeded: {
    label: 'succeeded',
    color: 'var(--ok)',
    bg: 'var(--ok-bg)',
    border: 'var(--ok-border)',
  },
  failed: {
    label: 'failed',
    color: 'var(--danger)',
    bg: 'var(--danger-bg)',
    border: 'var(--danger-border)',
  },
  cancelled: {
    label: 'cancelled',
    color: 'var(--muted)',
    bg: 'var(--bg-2)',
    border: 'var(--border)',
  },
};

export function RunView({ slug, runId }: { slug: string; runId: string }) {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null);
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [waits, setWaits] = useState<WorkflowWait[]>([]);
  const [timeline, setTimeline] = useState<RunTimelineEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .run(runId)
      .then((r) => {
        setRun(r.run);
        setDefinition(r.definition);
        setSteps(r.steps);
        setWaits(r.waits);
        setTimeline(r.timeline);
        setSelected((prev) => {
          if (prev) return prev;
          const open = r.waits.find((w) => w.status === 'open');
          return open?.nodeId ?? r.steps[r.steps.length - 1]?.nodeId ?? null;
        });
      })
      .catch((e) => setError(String(e)));
  }, [runId]);

  useEffect(() => {
    load();
    const es = new EventSource('/api/workflows/stream');
    es.onmessage = (e) => {
      const evt = JSON.parse(e.data) as { runId?: string };
      if (!evt.runId || evt.runId === runId) load();
    };
    return () => es.close();
  }, [load, runId]);

  const statuses = useMemo(() => toStatuses(steps), [steps]);
  const durations = useMemo(() => {
    const out: Record<string, string> = {};
    for (const s of steps) out[s.nodeId] = took(s);
    return out;
  }, [steps]);

  const selectedStep = steps.find((s) => s.nodeId === selected) ?? null;
  const selectedWait = waits.find(
    (w) => w.nodeId === selected && w.status === 'open',
  );

  if (error && !run)
    return <p className="text-sm text-[color:var(--danger)]">{error}</p>;
  if (!run || !definition)
    return <p className="text-sm text-[color:var(--muted)]">Loading…</p>;

  const pill = PILL[run.status] ?? PILL.queued;
  const done = steps.filter((s) => s.status === 'succeeded').length;
  const total = Object.keys(definition.nodes ?? {}).length;
  const runsHref = `/workflows/${encodeURIComponent(slug)}?tab=runs`;

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        crumbs={[
          { label: 'Workflows', href: '/workflows' },
          { label: slug, href: runsHref },
        ]}
        title={run.id}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={runsHref}
          className="flex items-center gap-1.5 rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-2.5 py-1 text-[12px] text-[color:var(--muted)] hover:text-[color:var(--fg)]"
        >
          ‹ All runs
        </Link>
        <span
          className="flex items-center gap-2 rounded-full border px-3 py-1 text-[12px] font-medium"
          style={{
            color: pill.color,
            background: pill.bg,
            borderColor: pill.border,
          }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: pill.color }}
          />
          {pill.label}
        </span>
        <span className="font-mono text-[11.5px] text-[color:var(--muted)]">
          started {shortTime(run.startedAt)} · {done} of {total} steps
          {run.finishedAt ? ` · finished ${shortTime(run.finishedAt)}` : ''}
          {run.parentRunId
            ? ` · forked from ${run.parentRunId} at ${run.forkedAtNode}`
            : ''}
        </span>
        <span className="grow" />
        {(run.status === 'running' || run.status === 'waiting') && (
          <button
            type="button"
            onClick={async () => {
              await api.cancelRun(runId);
              load();
            }}
            className="rounded-md border border-[color:var(--border)] px-2.5 py-1 text-[12px] text-[color:var(--muted)] hover:text-[color:var(--fg)]"
          >
            Cancel run
          </button>
        )}
        {(run.status === 'succeeded' ||
          run.status === 'failed' ||
          run.status === 'cancelled') && (
          <button
            type="button"
            onClick={async () => {
              const res = await api.runWorkflow(slug);
              if (res.runId)
                window.location.href = `/workflows/${encodeURIComponent(
                  slug,
                )}/runs/${res.runId}`;
            }}
            className="rounded-md border border-[color:var(--border)] px-2.5 py-1 text-[12px] text-[color:var(--muted)] hover:text-[color:var(--fg)]"
          >
            Run it again
          </button>
        )}
      </div>

      {run.error && (
        <p className="rounded-md border border-[color:var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-[11.5px] text-[color:var(--danger)]">
          {run.error}
        </p>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <WorkflowCanvas
          definition={definition}
          statuses={statuses}
          durations={durations}
          selected={selected}
          onSelect={setSelected}
          height="min(62vh, 560px)"
        />

        <aside className="flex min-w-0 flex-col gap-3">
          {selected ? (
            <div className="overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]">
              <div className="border-b border-[color:var(--border)] px-3.5 py-3">
                <div className="font-mono text-[13px]">{selected}</div>
                <div className="mt-0.5 text-[11px] text-[color:var(--muted)]">
                  {definition.nodes[selected]?.type}
                  {selectedStep
                    ? ` · ${selectedStep.status}${
                        selectedStep.port ? ` → ${selectedStep.port}` : ''
                      } · attempt ${selectedStep.attempt}${
                        took(selectedStep) ? ` · ${took(selectedStep)}` : ''
                      }`
                    : ' · not started'}
                </div>
              </div>

              {selectedWait && (
                <div className="border-b border-[color:var(--border)] bg-[var(--warn-bg)] px-3.5 py-3">
                  <div className="mb-2 text-[10.5px] uppercase tracking-wider text-[color:var(--warn)]">
                    Waiting on you
                  </div>
                  <WaitControls wait={selectedWait} onDone={load} />
                </div>
              )}

              <div className="px-3.5 py-3">
                <div className="mb-1.5 text-[10.5px] uppercase tracking-wider text-[color:var(--muted)]">
                  Output
                </div>
                {selectedStep?.error ? (
                  <pre className="max-h-52 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[color:var(--danger)]">
                    {selectedStep.error}
                  </pre>
                ) : (
                  <pre className="max-h-52 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[color:var(--muted)]">
                    {selectedStep
                      ? JSON.stringify(selectedStep.output, null, 2)
                      : '—'}
                  </pre>
                )}
              </div>

              <div className="flex flex-wrap gap-2 px-3.5 pb-3.5">
                {selectedStep && (
                  <button
                    type="button"
                    onClick={async () => {
                      const res = await api.retryRun(runId, selected);
                      window.location.href = `/workflows/${encodeURIComponent(
                        slug,
                      )}/runs/${res.runId}`;
                    }}
                    className="rounded-md border border-[color:var(--border)] px-2.5 py-1 text-[11.5px] text-[color:var(--muted)] hover:text-[color:var(--fg)]"
                  >
                    Retry from here
                  </button>
                )}
                {selectedStep?.agentSessionId && (
                  <Link
                    href={`/admin/transcripts?session=${selectedStep.agentSessionId}`}
                    className="rounded-md border border-[color:var(--border)] px-2.5 py-1 text-[11.5px] text-[color:var(--muted)] hover:text-[color:var(--fg)]"
                  >
                    Agent transcript
                  </Link>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-[color:var(--muted)]">
              Select a node to see its output and log.
            </p>
          )}

          <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] px-3.5 py-3">
            <div className="mb-2 text-[10.5px] uppercase tracking-wider text-[color:var(--muted)]">
              Timeline
            </div>
            <ol className="flex flex-col gap-1.5">
              {timeline.map((t) => (
                <li key={t.id} className="flex items-baseline gap-2.5">
                  <span className="shrink-0 font-mono text-[10.5px] text-[color:var(--muted)]">
                    {t.ts.slice(11, 19)}
                  </span>
                  <span
                    className="font-mono text-[11px]"
                    style={{
                      color: t.kind.includes('failed')
                        ? 'var(--danger)'
                        : t.kind.includes('wait')
                          ? 'var(--warn)'
                          : 'var(--ok)',
                    }}
                  >
                    {t.kind}
                  </span>
                  <span className="truncate font-mono text-[11px] text-[color:var(--muted)]">
                    {t.node_id ?? ''}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </div>
    </div>
  );
}
