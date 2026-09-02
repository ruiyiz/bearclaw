'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { WorkflowGraph, type NodeStatus } from '@/components/workflow-graph';
import {
  api,
  type RunTimelineEntry,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowStep,
  type WorkflowWait,
} from '@/lib/api';
import { shortTime, statusColor } from '../../../workflows-view';

function toStatuses(steps: WorkflowStep[]): Record<string, NodeStatus> {
  const out: Record<string, NodeStatus> = {};
  for (const s of steps) out[s.nodeId] = s.status as NodeStatus;
  return out;
}

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
  const selectedStep = steps.find((s) => s.nodeId === selected) ?? null;
  const selectedWait = waits.find(
    (w) => w.nodeId === selected && w.status === 'open',
  );

  if (error && !run) return <p className="text-sm text-[#d05353]">{error}</p>;
  if (!run || !definition)
    return <p className="text-sm text-[color:var(--muted)]">Loading…</p>;

  return (
    <div className="max-w-5xl mx-auto flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Link
            href={`/workflows/${encodeURIComponent(slug)}`}
            className="text-sm hover:underline"
          >
            {slug}
          </Link>
          <h1 className="text-base font-medium">
            <span className={statusColor(run.status)}>{run.status}</span>{' '}
            <span className="text-xs text-[color:var(--muted)] font-normal">
              {run.id}
            </span>
          </h1>
          <p className="text-xs text-[color:var(--muted)]">
            started {shortTime(run.startedAt)}
            {run.finishedAt ? ` · finished ${shortTime(run.finishedAt)}` : ''}
            {run.parentRunId
              ? ` · forked from ${run.parentRunId} at ${run.forkedAtNode}`
              : ''}
          </p>
          {run.error && (
            <p className="text-xs text-[#d05353] mt-1">{run.error}</p>
          )}
        </div>
        {(run.status === 'running' || run.status === 'waiting') && (
          <button
            onClick={async () => {
              await api.cancelRun(runId);
              load();
            }}
            className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:bg-[color:var(--card)]"
          >
            Cancel
          </button>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-[1fr_320px]">
        <WorkflowGraph
          definition={definition}
          statuses={statuses}
          selected={selected}
          onSelect={setSelected}
          height={480}
        />

        <aside className="flex flex-col gap-3 min-w-0">
          {selected ? (
            <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-3 flex flex-col gap-2">
              <div>
                <div className="text-sm font-medium">{selected}</div>
                <div className="text-xs text-[color:var(--muted)]">
                  {definition.nodes[selected]?.type}
                  {selectedStep
                    ? ` · ${selectedStep.status}${
                        selectedStep.port ? ` → ${selectedStep.port}` : ''
                      } · attempt ${selectedStep.attempt}`
                    : ' · not run'}
                </div>
              </div>

              {selectedStep?.error && (
                <pre className="text-xs whitespace-pre-wrap text-[#d05353]">
                  {selectedStep.error}
                </pre>
              )}

              {selectedStep && selectedStep.output !== null && (
                <pre className="text-xs whitespace-pre-wrap break-all max-h-56 overflow-y-auto">
                  {JSON.stringify(selectedStep.output, null, 2)}
                </pre>
              )}

              {selectedStep?.agentSessionId && (
                <Link
                  href={`/admin/transcripts?session=${selectedStep.agentSessionId}`}
                  className="text-xs underline text-[color:var(--muted)]"
                >
                  Agent transcript
                </Link>
              )}

              {selectedWait && (
                <WaitControls wait={selectedWait} onDone={load} />
              )}

              {selectedStep && (
                <button
                  onClick={async () => {
                    const res = await api.retryRun(runId, selected);
                    window.location.href = `/workflows/${encodeURIComponent(
                      slug,
                    )}/runs/${res.runId}`;
                  }}
                  className="self-start text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:bg-[color:var(--bg)]"
                >
                  Retry from here
                </button>
              )}
            </div>
          ) : (
            <p className="text-sm text-[color:var(--muted)]">
              Select a node to see its input, output and log.
            </p>
          )}

          <div className="rounded-lg border border-[color:var(--border)] p-3">
            <div className="text-sm mb-2">Timeline</div>
            <ol className="flex flex-col gap-1">
              {timeline.map((t) => (
                <li key={t.id} className="text-xs text-[color:var(--muted)]">
                  {t.ts.slice(11, 19)} · {t.kind}
                  {t.node_id ? ` · ${t.node_id}` : ''}
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </div>
    </div>
  );
}

export function WaitControls({
  wait,
  onDone,
}: {
  wait: WorkflowWait;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const respond = async (response: unknown) => {
    setBusy(true);
    try {
      await api.respondToWait(wait.id, response);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-[color:var(--border)] pt-2">
      {wait.prompt && <p className="text-sm">{wait.prompt}</p>}
      {wait.kind === 'human' && wait.options?.length ? (
        <div className="flex gap-1 flex-wrap">
          {wait.options.map((o) => (
            <button
              key={o}
              disabled={busy}
              onClick={() => respond({ choice: o })}
              className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:bg-[color:var(--bg)]"
            >
              {o}
            </button>
          ))}
        </div>
      ) : null}
      {!wait.options?.length && (
        <>
          <div className="flex gap-1">
            <button
              disabled={busy}
              onClick={() => respond({ approved: true })}
              className="text-xs px-2 py-1 rounded-md border border-[#3fa06b] text-[#3fa06b] hover:bg-[color:var(--bg)]"
            >
              Approve
            </button>
            <button
              disabled={busy}
              onClick={() => respond({ approved: false })}
              className="text-xs px-2 py-1 rounded-md border border-[#d05353] text-[#d05353] hover:bg-[color:var(--bg)]"
            >
              Reject
            </button>
          </div>
          <div className="flex gap-1">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Or reply with text"
              className="flex-1 text-xs rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1"
            />
            <button
              disabled={busy || !text.trim()}
              onClick={() => respond({ text })}
              className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </>
      )}
      {wait.expiresAt && (
        <p className="text-xs text-[color:var(--muted)]">
          expires {shortTime(wait.expiresAt)}
        </p>
      )}
    </div>
  );
}
