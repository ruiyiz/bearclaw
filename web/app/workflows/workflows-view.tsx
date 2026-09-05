'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { NewWorkflowDialog } from '@/components/new-workflow-dialog';
import { PageHeader } from '@/components/page-header';
import { TagChip } from '@/components/tag-chip';
import { TagDialog } from '@/components/tag-dialog';
import { WaitControls } from '@/components/wait-controls';
import { api, type WorkflowSummary, type WorkflowWait } from '@/lib/api';
import { ago, shortTime, statusColor } from '@/lib/format';

// A pseudo-tag, so the ones nobody has filed yet are reachable from the same
// row of chips.
const UNTAGGED = '\u2014untagged';

export function WorkflowsView() {
  const [rows, setRows] = useState<WorkflowSummary[] | null>(null);
  const [waits, setWaits] = useState<WorkflowWait[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [tagging, setTagging] = useState<WorkflowSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const load = useCallback(() => {
    api
      .workflows()
      .then((r) => setRows(r.workflows))
      .catch((e) => setError(String(e)));
    api
      .waits()
      .then((r) => setWaits(r.waits))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const es = new EventSource('/api/workflows/stream');
    es.onmessage = () => load();
    return () => es.close();
  }, [load]);

  // The filter is where you left it, because it is how a shelf of forty
  // workflows stays navigable between visits.
  useEffect(() => {
    try {
      const saved = localStorage.getItem('nc.wfTags');
      if (saved) setActiveTags(JSON.parse(saved) as string[]);
    } catch {
      /* private mode */
    }
  }, []);

  const toggleTag = (tag: string) =>
    setActiveTags((prev) => {
      const next = prev.includes(tag)
        ? prev.filter((x) => x !== tag)
        : [...prev, tag];
      try {
        localStorage.setItem('nc.wfTags', JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });

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
      setMenuFor(null);
    }
  };

  const toggle = async (slug: string, enabled: boolean) => {
    await api.setWorkflowEnabled(slug, enabled);
    setMenuFor(null);
    load();
  };

  // Counts are over everything, so a tag never looks empty just because
  // another filter is on.
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let untagged = 0;
    for (const w of rows ?? []) {
      if (!w.tags?.length) untagged += 1;
      for (const tag of w.tags ?? [])
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return {
      list: [...counts.entries()].sort((a, b) =>
        b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1],
      ),
      untagged,
    };
  }, [rows]);

  const shown = useMemo(() => {
    const list = rows ?? [];
    if (!activeTags.length) return list;
    return list.filter((w) =>
      activeTags.every((tag) =>
        tag === UNTAGGED ? !w.tags?.length : (w.tags ?? []).includes(tag),
      ),
    );
  }, [rows, activeTags]);

  const stats = useMemo(() => {
    const list = rows ?? [];
    const next = list
      .filter((w) => w.nextRunAt)
      .sort((a, b) => (a.nextRunAt! < b.nextRunAt! ? -1 : 1))[0];
    return {
      next,
      waiting: waits.length,
      oldest: waits.length
        ? ago(
            waits
              .map((w) => w.createdAt)
              .sort()
              .at(0)!,
          )
        : '',
    };
  }, [rows, waits]);

  if (error && !rows)
    return <p className="text-sm text-[color:var(--danger)]">{error}</p>;
  if (!rows)
    return <p className="text-sm text-[color:var(--muted)]">Loading…</p>;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Workflows"
        subtitle={`${
          activeTags.length
            ? `${shown.length} of ${rows.length}`
            : `${rows.length} definition${rows.length === 1 ? '' : 's'}`
        }${waits.length ? ` · ${waits.length} waiting on you` : ''}`}
        actions={
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 rounded-md bg-[color:var(--accent)] px-3 py-1.5 text-[12px] font-semibold text-[color:var(--on-accent)]"
          >
            <svg
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            New workflow
          </button>
        }
      />

      {tagging && (
        <TagDialog
          slug={tagging.slug}
          name={tagging.name}
          suggestions={tagCounts.list.map(([tag]) => tag)}
          onClose={() => setTagging(null)}
          onSaved={load}
        />
      )}

      <NewWorkflowDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(slug) => {
          setCreating(false);
          router.push(`/workflows/${encodeURIComponent(slug)}`);
        }}
        taken={rows.map((w) => w.slug)}
      />

      {error && <p className="text-xs text-[color:var(--danger)]">{error}</p>}

      <div className="grid gap-2.5 sm:grid-cols-3">
        <Stat
          label="Next fire"
          value={stats.next ? shortTime(stats.next.nextRunAt) : '—'}
          note={stats.next?.slug ?? 'nothing scheduled'}
        />
        <Stat
          label="Definitions"
          value={String(rows.length)}
          note={`${rows.filter((w) => w.enabled).length} live`}
        />
        <Stat
          label="Waiting on you"
          value={String(waits.length)}
          note={stats.oldest ? `oldest ${stats.oldest}` : 'nothing parked'}
          accent={waits.length > 0}
        />
      </div>

      {waits.length > 0 && (
        <section className="overflow-hidden rounded-lg border border-[color:var(--warn-border)] bg-[var(--warn-bg)]">
          <div className="flex items-center gap-2.5 border-b border-[color:var(--warn-border)] px-4 py-2.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--warn)]" />
            <span className="text-[11px] uppercase tracking-wider text-[color:var(--warn)]">
              Waiting on you
            </span>
            <span className="font-mono text-[11px] text-[color:var(--muted)]">
              {waits.length} run{waits.length === 1 ? '' : 's'} parked on a
              human step
            </span>
          </div>
          {waits.map((w) => (
            <div
              key={w.id}
              className="border-b border-[color:var(--warn-border)] px-4 py-3 last:border-b-0"
            >
              <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
                <Link
                  href={`/workflows/${encodeURIComponent(
                    w.slug ?? '',
                  )}/runs/${w.runId}`}
                  className="font-mono text-[11.5px] text-[color:var(--accent)] hover:underline"
                >
                  {w.slug} / {w.nodeId}
                </Link>
                <span className="text-[11px] text-[color:var(--muted)]">
                  {ago(w.createdAt)}
                </span>
                <span className="grow" />
                {w.expiresAt && (
                  <span className="text-[11px] text-[color:var(--muted)]">
                    expires {shortTime(w.expiresAt)}
                  </span>
                )}
              </div>
              <WaitControls wait={w} onDone={load} />
            </div>
          ))}
        </section>
      )}

      {tagCounts.list.length === 0 && rows.length > 0 && (
        <p className="text-[11.5px] text-[color:var(--muted)]">
          No tags yet. Tag a workflow from the ⋯ menu on its row, or in the
          panel beside its graph — then they show up here as filters.
        </p>
      )}

      {(tagCounts.list.length > 0 || activeTags.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setActiveTags([]);
              try {
                localStorage.removeItem('nc.wfTags');
              } catch {
                /* private mode */
              }
            }}
            className="rounded-full border px-2 py-0.5 font-mono text-[11.5px]"
            style={{
              borderColor: activeTags.length
                ? 'var(--border)'
                : 'var(--accent)',
              color: activeTags.length ? 'var(--muted)' : 'var(--fg)',
              background: activeTags.length
                ? 'transparent'
                : 'var(--accent-soft)',
            }}
          >
            all {rows.length}
          </button>
          {tagCounts.list.map(([tag, count]) => (
            <TagChip
              key={tag}
              tag={tag}
              count={count}
              active={activeTags.includes(tag)}
              onClick={() => toggleTag(tag)}
            />
          ))}
          {tagCounts.untagged > 0 && (
            <TagChip
              tag="untagged"
              count={tagCounts.untagged}
              active={activeTags.includes(UNTAGGED)}
              onClick={() => toggleTag(UNTAGGED)}
            />
          )}
        </div>
      )}

      <section className="overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]">
        <div className="hidden grid-cols-[minmax(0,1fr)_90px_140px_150px_90px_58px] gap-3 border-b border-[color:var(--border)] px-4 py-2 text-[10.5px] uppercase tracking-wider text-[color:var(--muted)] md:grid">
          <span>Workflow</span>
          <span>Owner</span>
          <span>Trigger</span>
          <span>Next run</span>
          <span>Last</span>
          <span />
        </div>
        {rows.length === 0 && (
          <p className="px-4 py-6 text-sm text-[color:var(--muted)]">
            No workflows yet. Create one, or import a definition.
          </p>
        )}
        {rows.length > 0 && shown.length === 0 && (
          <p className="px-4 py-6 text-sm text-[color:var(--muted)]">
            Nothing carries{' '}
            {activeTags.length === 1 ? 'that tag' : 'all of those tags'}.
          </p>
        )}
        {shown.map((w) => (
          <div
            key={w.slug}
            className="group relative grid grid-cols-1 gap-1 border-b border-[color:var(--border)] px-4 py-2.5 last:border-b-0 hover:bg-[color:var(--bg-2)] md:grid-cols-[minmax(0,1fr)_90px_140px_150px_90px_58px] md:items-center md:gap-3"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{
                  background: !w.enabled
                    ? '#5b6169'
                    : w.lastStatus === 'failed'
                      ? 'var(--danger)'
                      : w.lastStatus === 'waiting'
                        ? 'var(--warn)'
                        : 'var(--ok)',
                }}
              />
              <span className="min-w-0">
                <Link
                  href={`/workflows/${encodeURIComponent(w.slug)}`}
                  className="block truncate text-[13px] font-medium hover:underline"
                >
                  {w.name}
                </Link>
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate font-mono text-[11px] text-[color:var(--muted)]">
                    {w.slug} · {w.nodeCount} node{w.nodeCount === 1 ? '' : 's'}
                    {w.enabled ? '' : ' · paused'}
                  </span>
                  {(w.tags ?? []).map((tag) => (
                    <TagChip
                      key={tag}
                      tag={tag}
                      size="xs"
                      active={activeTags.includes(tag)}
                      onClick={() => toggleTag(tag)}
                    />
                  ))}
                </span>
              </span>
            </div>
            <span className="hidden truncate font-mono text-[11.5px] text-[color:var(--muted)] md:block">
              {w.owner}
            </span>
            <span className="hidden truncate font-mono text-[11.5px] text-[color:var(--muted)] md:block">
              {w.triggers.length
                ? [...new Set(w.triggers.map((t) => t.type))].join(' · ')
                : 'no triggers'}
            </span>
            {/* On a phone these two ride together under the name; at md they
                take their own columns. */}
            <span className="flex items-baseline gap-2 md:contents">
              <span className="truncate font-mono text-[11.5px] text-[color:var(--muted)]">
                {w.nextRunAt ? shortTime(w.nextRunAt) : '—'}
              </span>
              <span
                className={`truncate text-[11.5px] ${statusColor(w.lastStatus)}`}
              >
                {w.lastStatus ?? 'idle'}
              </span>
            </span>

            <div className="absolute right-3 top-2.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 md:static md:justify-self-end">
              <button
                type="button"
                title={`Run ${w.name} now`}
                onClick={() => run(w.slug)}
                disabled={busy === w.slug}
                className="rounded px-1.5 py-0.5 text-[color:var(--muted)] hover:bg-[color:var(--card)] hover:text-[color:var(--fg)] disabled:opacity-50"
              >
                ▸
              </button>
              <button
                type="button"
                title="More"
                onClick={() =>
                  setMenuFor((m) => (m === w.slug ? null : w.slug))
                }
                className="rounded px-1.5 py-0.5 text-[color:var(--muted)] hover:bg-[color:var(--card)] hover:text-[color:var(--fg)]"
              >
                ⋯
              </button>
              {menuFor === w.slug && (
                <div className="absolute right-0 top-7 z-10 w-40 overflow-hidden rounded-md border border-[color:var(--border)] bg-[color:var(--card)] py-1 shadow-lg">
                  <button
                    type="button"
                    onClick={() => {
                      setMenuFor(null);
                      setTagging(w);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[color:var(--bg-2)]"
                  >
                    Tags…
                  </button>
                  <button
                    type="button"
                    onClick={() => toggle(w.slug, !w.enabled)}
                    className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[color:var(--bg-2)]"
                  >
                    {w.enabled ? 'Pause workflow' : 'Resume workflow'}
                  </button>
                  <Link
                    href={`/workflows/${encodeURIComponent(w.slug)}?tab=runs`}
                    className="block px-3 py-1.5 text-[12px] hover:bg-[color:var(--bg-2)]"
                  >
                    Runs
                  </Link>
                  <Link
                    href={`/workflows/${encodeURIComponent(
                      w.slug,
                    )}?tab=definition`}
                    className="block px-3 py-1.5 text-[12px] hover:bg-[color:var(--bg-2)]"
                  >
                    Definition
                  </Link>
                </div>
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  note,
  accent,
}: {
  label: string;
  value: string;
  note: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-[color:var(--muted)]">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span
          className="text-[19px] font-semibold tracking-tight"
          style={accent ? { color: 'var(--accent)' } : undefined}
        >
          {value}
        </span>
        <span className="truncate font-mono text-[11px] text-[color:var(--muted)]">
          {note}
        </span>
      </div>
    </div>
  );
}
