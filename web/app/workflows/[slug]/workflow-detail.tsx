'use client';

import CodeMirror from '@uiw/react-codemirror';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { WorkflowGraph } from '@/components/workflow-graph';
import {
  api,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowSummary,
  type WorkflowTrigger,
} from '@/lib/api';
import { shortTime, statusColor } from '../workflows-view';

type Tab = 'graph' | 'triggers' | 'runs' | 'definition';

export function WorkflowDetail({ slug }: { slug: string }) {
  const [summary, setSummary] = useState<WorkflowSummary | null>(null);
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const [tab, setTab] = useState<Tab>('graph');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .workflow(slug)
      .then((r) => {
        setSummary(r.workflow);
        setDefinition(r.definition);
        setRuns(r.runs);
        setTriggers(r.workflow.triggers);
        setDraft((prev) =>
          prev ? prev : `${JSON.stringify(r.definition, null, 2)}\n`,
        );
      })
      .catch((e) => setError(String(e)));
  }, [slug]);

  useEffect(() => {
    load();
    const es = new EventSource('/api/workflows/stream');
    es.onmessage = (e) => {
      const evt = JSON.parse(e.data) as { slug?: string };
      if (!evt.slug || evt.slug === slug) load();
    };
    return () => es.close();
  }, [load, slug]);

  // The editor and the graph preview are the same document: the preview
  // re-renders on every keystroke that still parses.
  const preview = useMemo(() => {
    try {
      const parsed = JSON.parse(draft) as WorkflowDefinition;
      if (!parsed.nodes) return definition;
      return parsed;
    } catch {
      return definition;
    }
  }, [draft, definition]);

  const draftValid = useMemo(() => {
    try {
      JSON.parse(draft);
      return true;
    } catch {
      return false;
    }
  }, [draft]);

  const save = async () => {
    setError(null);
    setNotice(null);
    try {
      const parsed = JSON.parse(draft);
      const res = await api.saveWorkflow(slug, parsed);
      setDefinition(res.definition);
      setNotice('Saved.');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runNow = async () => {
    setError(null);
    try {
      const res = await api.runWorkflow(slug);
      setNotice(res.runId ? `Started run ${res.runId}.` : `Run ${res.status}.`);
      load();
    } catch (e) {
      setError(String(e));
    }
  };

  if (error && !definition)
    return <p className="text-sm text-[#d05353]">{error}</p>;
  if (!summary || !definition)
    return <p className="text-sm text-[color:var(--muted)]">Loading…</p>;

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-medium">{summary.name}</h1>
          <p className="text-xs text-[color:var(--muted)]">
            {summary.slug} · {summary.owner} · {summary.nodeCount} nodes
            {summary.enabled ? '' : ' · paused'}
          </p>
        </div>
        <button
          onClick={runNow}
          className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:bg-[color:var(--card)]"
        >
          Run now
        </button>
      </div>

      {notice && <p className="text-xs text-[#3fa06b]">{notice}</p>}
      {error && (
        <p className="text-xs text-[#d05353] whitespace-pre-wrap">{error}</p>
      )}

      <div className="flex gap-1">
        {(['graph', 'triggers', 'runs', 'definition'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              'text-xs px-2 py-1 rounded-md capitalize ' +
              (tab === t
                ? 'bg-[color:var(--accent)] text-white'
                : 'border border-[color:var(--border)] hover:bg-[color:var(--card)]')
            }
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'graph' && (
        <WorkflowGraph definition={definition} height={460} />
      )}

      {tab === 'triggers' && (
        <TriggerPanel slug={slug} triggers={triggers} onChange={load} />
      )}

      {tab === 'runs' && (
        <div className="flex flex-col gap-1">
          {runs.length === 0 && (
            <p className="text-sm text-[color:var(--muted)]">No runs yet.</p>
          )}
          {runs.map((r) => (
            <Link
              key={r.id}
              href={`/workflows/${encodeURIComponent(slug)}/runs/${r.id}`}
              className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-2 hover:border-[color:var(--accent)]"
            >
              <div className="flex items-center gap-2">
                <span className={`text-xs ${statusColor(r.status)}`}>
                  {r.status}
                </span>
                <span className="text-xs text-[color:var(--muted)]">
                  {shortTime(r.startedAt)}
                </span>
                <span className="text-xs text-[color:var(--muted)] truncate">
                  {r.error ?? ''}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {tab === 'definition' && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={!draftValid}
              className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:bg-[color:var(--card)] disabled:opacity-50"
            >
              Save
            </button>
            <span className="text-xs text-[color:var(--muted)]">
              {draftValid ? 'Valid JSON' : 'Invalid JSON'}
            </span>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <div className="rounded-lg border border-[color:var(--border)] overflow-hidden">
              <CodeMirror
                value={draft}
                height="460px"
                onChange={setDraft}
                basicSetup={{ lineNumbers: true }}
              />
            </div>
            {preview && <WorkflowGraph definition={preview} height={460} />}
          </div>
        </div>
      )}
    </div>
  );
}

const TRIGGER_TYPES = ['cron', 'at', 'event', 'webhook', 'manual'] as const;

function TriggerPanel({
  slug,
  triggers,
  onChange,
}: {
  slug: string;
  triggers: WorkflowTrigger[];
  onChange: () => void;
}) {
  const [type, setType] = useState<(typeof TRIGGER_TYPES)[number]>('cron');
  const [config, setConfig] = useState('{ "cron": "0 9 * * *" }');
  const [args, setArgs] = useState('{}');
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    setToken(null);
    try {
      const res = await api.createTrigger({
        slug,
        type,
        config: JSON.parse(config || '{}'),
        args: JSON.parse(args || '{}'),
      });
      if (res.token) setToken(res.token);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        {triggers.length === 0 && (
          <p className="text-sm text-[color:var(--muted)]">No triggers.</p>
        )}
        {triggers.map((t) => (
          <div
            key={t.id}
            className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-2 flex items-start gap-2"
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm">
                {t.type}
                <span className="text-xs text-[color:var(--muted)]">
                  {' '}
                  · {t.source}
                  {t.enabled ? '' : ' · paused'}
                </span>
              </div>
              <div className="text-xs text-[color:var(--muted)] break-all">
                {JSON.stringify(t.config)}
                {Object.keys(t.args).length
                  ? ` · args ${JSON.stringify(t.args)}`
                  : ''}
              </div>
              <div className="text-xs text-[color:var(--muted)]">
                next {shortTime(t.nextRunAt)} · last {shortTime(t.lastFiredAt)}
              </div>
            </div>
            <div className="flex gap-1 shrink-0">
              <button
                onClick={async () => {
                  await api.updateTrigger(t.id, { enabled: !t.enabled });
                  onChange();
                }}
                className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:bg-[color:var(--bg)]"
              >
                {t.enabled ? 'Pause' : 'Resume'}
              </button>
              {t.source === 'runtime' && (
                <button
                  onClick={async () => {
                    await api.deleteTrigger(t.id);
                    onChange();
                  }}
                  className="text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:bg-[color:var(--bg)]"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-[color:var(--border)] p-3 flex flex-col gap-2">
        <div className="text-sm">Add a trigger</div>
        <div className="flex gap-1 flex-wrap">
          {TRIGGER_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={
                'text-xs px-2 py-1 rounded-md ' +
                (type === t
                  ? 'bg-[color:var(--accent)] text-white'
                  : 'border border-[color:var(--border)]')
              }
            >
              {t}
            </button>
          ))}
        </div>
        <label className="text-xs text-[color:var(--muted)]">config</label>
        <textarea
          value={config}
          onChange={(e) => setConfig(e.target.value)}
          rows={2}
          className="text-xs font-mono rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] p-2"
        />
        <label className="text-xs text-[color:var(--muted)]">args</label>
        <textarea
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          rows={2}
          className="text-xs font-mono rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] p-2"
        />
        <button
          onClick={create}
          className="self-start text-xs px-2 py-1 rounded-md border border-[color:var(--border)] hover:bg-[color:var(--card)]"
        >
          Create
        </button>
        {token && (
          <p className="text-xs text-[#3fa06b] break-all">
            Webhook token (shown once): {token}
          </p>
        )}
        {error && <p className="text-xs text-[#d05353]">{error}</p>}
      </div>
    </div>
  );
}
