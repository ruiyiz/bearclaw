'use client';

import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { GraphEditor } from '@/components/graph-editor';
import { PageHeader } from '@/components/page-header';
import { TriggerEditor } from '@/components/trigger-editor';
import { WorkflowCanvas } from '@/components/workflow-canvas';
import {
  api,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowSummary,
  type WorkflowTrigger,
} from '@/lib/api';
import { useResolvedTheme } from '@/lib/editor';
import { shortTime, statusColor } from '@/lib/format';

type Tab = 'graph' | 'triggers' | 'runs' | 'definition';
const TABS: Tab[] = ['graph', 'triggers', 'runs', 'definition'];

export function WorkflowDetail({ slug }: { slug: string }) {
  const [summary, setSummary] = useState<WorkflowSummary | null>(null);
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const editorTheme = useResolvedTheme();
  const params = useSearchParams();
  const wanted = params.get('tab') as Tab | null;
  const [tab, setTab] = useState<Tab>(
    wanted && TABS.includes(wanted) ? wanted : 'graph',
  );
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
        setDraft(`${JSON.stringify(r.definition, null, 2)}\n`);
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

  const saveJson = async () => {
    setError(null);
    setNotice(null);
    try {
      const res = await api.saveWorkflow(slug, JSON.parse(draft));
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
    return <p className="text-sm text-[color:var(--danger)]">{error}</p>;
  if (!summary || !definition)
    return <p className="text-sm text-[color:var(--muted)]">Loading…</p>;

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        crumbs={[{ label: 'Workflows', href: '/workflows' }]}
        title={summary.name}
        subtitle={`${summary.slug}${summary.enabled ? '' : ' · paused'}`}
        actions={
          <button
            type="button"
            onClick={runNow}
            className="flex items-center gap-1.5 rounded-md bg-[color:var(--accent)] px-3 py-1.5 text-[12px] font-semibold text-[color:var(--on-accent)]"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
              <path d="M8 5.5v13l11-6.5z" />
            </svg>
            Run {summary.name}
          </button>
        }
      />

      {notice && <p className="text-xs text-[color:var(--ok)]">{notice}</p>}
      {error && (
        <p className="whitespace-pre-wrap text-xs text-[color:var(--danger)]">
          {error}
        </p>
      )}

      <div className="flex gap-1 overflow-x-auto border-b border-[color:var(--border)]">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className="shrink-0 px-3 pb-2 text-[12.5px] capitalize"
            style={{
              color: tab === t ? 'var(--fg)' : 'var(--muted)',
              boxShadow: tab === t ? 'inset 0 -2px 0 var(--accent)' : 'none',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'graph' && (
        <GraphEditor
          slug={slug}
          definition={definition}
          onSaved={(d) => {
            setDefinition(d);
            setDraft(`${JSON.stringify(d, null, 2)}\n`);
            load();
          }}
        />
      )}

      {tab === 'triggers' && (
        <TriggerEditor
          slug={slug}
          triggers={triggers}
          definition={definition}
          onChanged={load}
        />
      )}

      {tab === 'runs' && (
        <div className="overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]">
          {runs.length === 0 && (
            <p className="px-4 py-6 text-sm text-[color:var(--muted)]">
              No runs yet.
            </p>
          )}
          {runs.map((r) => (
            <Link
              key={r.id}
              href={`/workflows/${encodeURIComponent(slug)}/runs/${r.id}`}
              className="flex items-center gap-3 border-b border-[color:var(--border)] px-4 py-2.5 last:border-b-0 hover:bg-[color:var(--bg-2)]"
            >
              <span className="min-w-0 grow truncate font-mono text-[11.5px] text-[color:var(--muted)]">
                {r.id}
              </span>
              <span
                className={`w-20 shrink-0 text-[11.5px] ${statusColor(r.status)}`}
              >
                {r.status}
              </span>
              <span className="shrink-0 font-mono text-[11.5px] text-[color:var(--muted)]">
                {shortTime(r.startedAt)}
              </span>
            </Link>
          ))}
        </div>
      )}

      {tab === 'definition' && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={saveJson}
              disabled={!draftValid}
              className="rounded-md border border-[color:var(--border)] px-2.5 py-1 text-[11.5px] hover:bg-[color:var(--card)] disabled:opacity-50"
            >
              Save
            </button>
            <span className="font-mono text-[11px] text-[color:var(--muted)]">
              {slug}.json · {draftValid ? 'valid JSON' : 'invalid JSON'}
            </span>
          </div>
          <div className="grid gap-2 xl:grid-cols-2">
            <div className="code-surface overflow-hidden rounded-lg border border-[color:var(--border)]">
              <CodeMirror
                value={draft}
                height="460px"
                onChange={setDraft}
                theme={editorTheme}
                extensions={[json(), EditorView.lineWrapping]}
                basicSetup={{ lineNumbers: true, foldGutter: true }}
              />
            </div>
            {preview && <WorkflowCanvas definition={preview} height={460} />}
          </div>
        </div>
      )}
    </div>
  );
}
