'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, type WorkflowDefinition, type WorkflowTrigger } from '@/lib/api';

type TriggerType = WorkflowTrigger['type'];

const TYPES: TriggerType[] = ['cron', 'at', 'event', 'webhook', 'manual'];

interface Spec {
  key: string;
  kind: 'text' | 'json' | 'enum';
  options?: string[];
  placeholder?: string;
}

const SPECS: Record<TriggerType, Spec[]> = {
  cron: [
    { key: 'cron', kind: 'text', placeholder: '0 20 * * *' },
    { key: 'timezone', kind: 'text', placeholder: 'America/New_York' },
    { key: 'catchup', kind: 'enum', options: ['skip', 'once', 'all'] },
  ],
  at: [{ key: 'at', kind: 'text', placeholder: '2026-09-10T09:00' }],
  event: [
    { key: 'event', kind: 'text', placeholder: 'email_received' },
    { key: 'filter', kind: 'json', placeholder: '{ "jid": "email:main" }' },
    { key: 'map', kind: 'json' },
  ],
  webhook: [],
  manual: [],
};

const NOTES: Record<TriggerType, string> = {
  cron: 'Times are read in the trigger’s own zone. The next fire is recomputed on save.',
  at: 'One shot. The row is removed once it has fired.',
  event:
    'Fires on any event whose payload matches. An empty filter fires on every event of that type.',
  webhook:
    'The path is reachable on the tunnel and carries its own token; the token is shown once, when the trigger is made.',
  manual:
    'Nothing schedules this one. It runs from the dashboard, the CLI, or the agent’s workflow_run tool.',
};

function summarize(
  t: WorkflowTrigger,
  config: Record<string, unknown>,
): string {
  switch (t.type) {
    case 'cron':
      return `${config.cron ?? ''}  ·  ${config.timezone ?? ''}`;
    case 'at':
      return String(config.at ?? '');
    case 'event':
      return `${config.event ?? ''}${
        config.filter ? `  ·  ${JSON.stringify(config.filter)}` : ''
      }`;
    case 'webhook':
      return 'POST /api/hooks/<token>';
    default:
      return 'dashboard, the CLI, or the agent’s workflow_run tool';
  }
}

const control =
  'w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1.5 font-mono text-[11.5px] text-[color:var(--fg)] outline-none focus:border-[color:var(--accent)]';

interface Draft {
  type: TriggerType;
  config: Record<string, unknown>;
  args: Record<string, unknown>;
}

export function TriggerEditor({
  slug,
  triggers,
  definition,
  onChanged,
}: {
  slug: string;
  triggers: WorkflowTrigger[];
  definition: WorkflowDefinition;
  onChanged: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selected, setSelected] = useState<string | null>(
    triggers[0]?.id ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jsonText, setJsonText] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!selected && triggers.length) setSelected(triggers[0].id);
    if (selected && !triggers.some((t) => t.id === selected))
      setSelected(triggers[0]?.id ?? null);
  }, [triggers, selected]);

  const draftOf = useCallback(
    (t: WorkflowTrigger): Draft =>
      drafts[t.id] ?? { type: t.type, config: t.config, args: t.args },
    [drafts],
  );

  const dirty = Object.keys(drafts).length;
  const current = triggers.find((t) => t.id === selected) ?? null;
  const draft = current ? draftOf(current) : null;
  const specs = draft ? SPECS[draft.type] : [];

  const patch = (t: WorkflowTrigger, next: Partial<Draft>) => {
    setError(null);
    setDrafts((prev) => ({
      ...prev,
      [t.id]: { ...draftOf(t), ...next },
    }));
  };

  const setConfig = (t: WorkflowTrigger, key: string, value: unknown) => {
    const config = { ...draftOf(t).config };
    if (value === undefined || value === '') delete config[key];
    else config[key] = value;
    patch(t, { config });
  };

  const toggle = async (t: WorkflowTrigger) => {
    setError(null);
    try {
      await api.updateTrigger(t.id, { enabled: !t.enabled });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // File-declared rows belong to the definition; runtime rows belong to the
  // database. The panel looks the same either way, the write does not.
  const saveAll = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      let fileTouched = false;
      const nextDef = JSON.parse(
        JSON.stringify(definition),
      ) as WorkflowDefinition;
      for (const [id, d] of Object.entries(drafts)) {
        const row = triggers.find((t) => t.id === id);
        if (!row) continue;
        if (row.source === 'file') {
          const declId = id.startsWith(`${slug}:`)
            ? id.slice(slug.length + 1)
            : id;
          const decls = (nextDef.triggers ?? []) as Record<string, unknown>[];
          const at = decls.findIndex((x) => x.id === declId);
          if (at >= 0) {
            decls[at] = {
              ...decls[at],
              type: d.type,
              ...d.config,
              ...(Object.keys(d.args).length ? { args: d.args } : {}),
            };
            fileTouched = true;
          }
        } else {
          await api.updateTrigger(id, { config: d.config, args: d.args });
        }
      }
      if (fileTouched) await api.saveWorkflow(slug, nextDef);
      setDrafts({});
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.createTrigger({
        slug,
        type: 'cron',
        config: { cron: '0 9 * * *' },
        args: {},
      });
      setSelected(res.trigger.id);
      if (res.token) setNotice(`webhook token, shown once: ${res.token}`);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: WorkflowTrigger) => {
    setBusy(true);
    setError(null);
    try {
      if (t.source === 'file') {
        const declId = t.id.startsWith(`${slug}:`)
          ? t.id.slice(slug.length + 1)
          : t.id;
        const nextDef = JSON.parse(
          JSON.stringify(definition),
        ) as WorkflowDefinition;
        nextDef.triggers = (
          (nextDef.triggers ?? []) as Record<string, unknown>[]
        ).filter((x) => x.id !== declId);
        await api.saveWorkflow(slug, nextDef);
      } else {
        await api.deleteTrigger(t.id);
      }
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[t.id];
        return next;
      });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const live = triggers.filter((t) => t.enabled).length;

  const nextFire = (t: WorkflowTrigger) => {
    if (!t.enabled) return 'paused';
    if (!t.nextRunAt) return '—';
    const d = new Date(t.nextRunAt);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? `Today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : d.toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
  };

  const previewLines = useMemo(() => {
    if (!current || !draft) return [];
    if (!current.enabled) return ['paused — nothing is scheduled'];
    if (draft.type === 'cron')
      return drafts[current.id]
        ? ['computed from the expression on save']
        : [nextFire(current)];
    if (draft.type === 'at') return [String(draft.config.at ?? '—')];
    return [];
  }, [current, draft, drafts]);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          onClick={add}
          disabled={busy}
          className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-2.5 py-1 text-[11.5px] hover:border-[color:var(--muted)]"
        >
          + Add trigger
        </button>
        <span className="font-mono text-[11.5px] text-[color:var(--muted)]">
          {triggers.length} trigger{triggers.length === 1 ? '' : 's'} · {live}{' '}
          live
        </span>
        <span className="grow" />
        {dirty === 0 ? (
          <span className="font-mono text-[11px] text-[color:var(--muted)]">
            in step with the file
          </span>
        ) : (
          <>
            <span className="text-[11.5px] text-[color:var(--warn)]">
              {dirty} unsaved change{dirty === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              onClick={() => {
                setDrafts({});
                setJsonText({});
              }}
              className="rounded-md border border-[color:var(--border)] px-2.5 py-1 text-[11.5px] text-[color:var(--muted)] hover:text-[color:var(--fg)]"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={saveAll}
              disabled={busy}
              className="rounded-md bg-[color:var(--accent)] px-3 py-1 text-[11.5px] font-medium text-[color:var(--on-accent)] disabled:opacity-60"
            >
              Save triggers
            </button>
          </>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-[color:var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-[11.5px] text-[color:var(--danger)]">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-2 font-mono text-[11.5px]">
          {notice}
        </p>
      )}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="min-w-0 grow overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]">
          {triggers.length === 0 && (
            <p className="px-4 py-6 text-[12px] text-[color:var(--muted)]">
              No triggers. The workflow only runs when something starts it by
              hand.
            </p>
          )}
          {triggers.map((t) => {
            const d = draftOf(t);
            const on = selected === t.id;
            return (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelected(t.id)}
                onKeyDown={(e) => e.key === 'Enter' && setSelected(t.id)}
                className="group flex cursor-pointer flex-wrap items-center gap-3 border-b border-[color:var(--border)] px-4 py-3 last:border-b-0"
                style={{
                  borderLeft: `2px solid ${on ? 'var(--accent)' : 'transparent'}`,
                  background: on ? 'var(--bg-2)' : 'transparent',
                  opacity: t.enabled ? 1 : 0.6,
                }}
              >
                <span className="w-16 shrink-0">
                  <span className="rounded border border-[color:var(--border)] px-1.5 py-0.5 font-mono text-[11px] text-[color:var(--muted)]">
                    {d.type}
                  </span>
                </span>
                <span className="min-w-0 grow">
                  <span className="block truncate font-mono text-[12px]">
                    {summarize(t, d.config)}
                  </span>
                  <span className="block text-[11px] text-[color:var(--muted)]">
                    {t.source === 'file'
                      ? `declared in ${slug}.json`
                      : 'added here · lives in the database'}
                  </span>
                </span>
                <span className="font-mono text-[11.5px] text-[color:var(--muted)]">
                  {nextFire(t)}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void toggle(t);
                  }}
                  className="rounded-md border border-[color:var(--border)] px-2.5 py-1 text-[11.5px] text-[color:var(--muted)] hover:text-[color:var(--fg)]"
                >
                  {t.enabled ? 'Pause' : 'Resume'}
                </button>
                <button
                  type="button"
                  aria-label="delete trigger"
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove(t);
                  }}
                  className="rounded px-1 text-[color:var(--muted)] opacity-0 hover:text-[color:var(--fg)] group-hover:opacity-100"
                >
                  ✕
                </button>
              </div>
            );
          })}
          <p className="bg-[color:var(--bg-2)] px-4 py-3 text-[11.5px] leading-relaxed text-[color:var(--muted)]">
            Saving writes the file-declared rows back to {slug}.json and the
            rest to the database. Pausing takes effect at once either way.
          </p>
        </div>

        {current && draft && (
          <div className="shrink-0 overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] lg:w-[316px]">
            <div className="flex items-center gap-2 border-b border-[color:var(--border)] bg-[color:var(--bg-2)] px-3 py-2.5">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{
                  background: current.enabled ? 'var(--ok)' : '#5b6169',
                }}
              />
              <span className="min-w-0 grow truncate font-mono text-[12.5px]">
                {current.id}
              </span>
            </div>

            <div className="flex flex-wrap gap-1 border-b border-[color:var(--border)] px-3 py-2.5">
              {TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() =>
                    patch(current, {
                      type: t,
                      config: t === draft.type ? draft.config : {},
                    })
                  }
                  className="rounded-md border px-2 py-0.5 font-mono text-[11px]"
                  style={{
                    borderColor:
                      t === draft.type ? 'var(--accent)' : 'var(--border)',
                    color: t === draft.type ? 'var(--fg)' : 'var(--muted)',
                  }}
                >
                  {t}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-3 px-3 py-3">
              {specs.map((spec) => {
                const raw = draft.config[spec.key];
                if (spec.kind === 'enum')
                  return (
                    <div key={spec.key}>
                      <span className="mb-1 block font-mono text-[10.5px] text-[color:var(--muted)]">
                        {spec.key}
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {(spec.options ?? []).map((o) => (
                          <button
                            key={o}
                            type="button"
                            onClick={() => setConfig(current, spec.key, o)}
                            className="rounded-md border px-2 py-0.5 font-mono text-[11px]"
                            style={{
                              borderColor:
                                String(raw ?? spec.options?.[0]) === o
                                  ? 'var(--accent)'
                                  : 'var(--border)',
                              color:
                                String(raw ?? spec.options?.[0]) === o
                                  ? 'var(--fg)'
                                  : 'var(--muted)',
                            }}
                          >
                            {o}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                if (spec.kind === 'json') {
                  const key = `${current.id}:${spec.key}`;
                  const text =
                    jsonText[key] ??
                    (raw === undefined ? '' : JSON.stringify(raw, null, 2));
                  return (
                    <div key={spec.key}>
                      <span className="mb-1 block font-mono text-[10.5px] text-[color:var(--muted)]">
                        {spec.key}
                      </span>
                      <textarea
                        rows={3}
                        value={text}
                        placeholder={spec.placeholder}
                        onChange={(e) => {
                          setJsonText((p) => ({ ...p, [key]: e.target.value }));
                          if (e.target.value.trim() === '')
                            return setConfig(current, spec.key, undefined);
                          try {
                            setConfig(
                              current,
                              spec.key,
                              JSON.parse(e.target.value),
                            );
                          } catch {
                            /* keep typing */
                          }
                        }}
                        className={`${control} resize-y`}
                      />
                    </div>
                  );
                }
                return (
                  <div key={spec.key}>
                    <span className="mb-1 block font-mono text-[10.5px] text-[color:var(--muted)]">
                      {spec.key}
                    </span>
                    <input
                      value={String(raw ?? '')}
                      placeholder={spec.placeholder}
                      onChange={(e) =>
                        setConfig(current, spec.key, e.target.value)
                      }
                      className={control}
                    />
                  </div>
                );
              })}

              <div>
                <span className="mb-1 block font-mono text-[10.5px] text-[color:var(--muted)]">
                  args
                </span>
                <textarea
                  rows={2}
                  value={
                    jsonText[`${current.id}:args`] ??
                    (Object.keys(draft.args).length
                      ? JSON.stringify(draft.args, null, 2)
                      : '')
                  }
                  placeholder="{}"
                  onChange={(e) => {
                    setJsonText((p) => ({
                      ...p,
                      [`${current.id}:args`]: e.target.value,
                    }));
                    if (e.target.value.trim() === '')
                      return patch(current, { args: {} });
                    try {
                      patch(current, {
                        args: JSON.parse(e.target.value) as Record<
                          string,
                          unknown
                        >,
                      });
                    } catch {
                      /* keep typing */
                    }
                  }}
                  className={`${control} resize-y`}
                />
              </div>
            </div>

            <div className="border-t border-[color:var(--border)] px-3 py-3">
              <span className="mb-1.5 block text-[10.5px] uppercase tracking-wider text-[color:var(--muted)]">
                {previewLines.length ? 'Next fire' : 'How it fires'}
              </span>
              {previewLines.map((line) => (
                <p
                  key={line}
                  className="font-mono text-[11.5px] text-[color:var(--muted)]"
                >
                  {line}
                </p>
              ))}
              <p className="mt-2 text-[11px] leading-relaxed text-[color:var(--muted)]">
                {NOTES[draft.type]}
              </p>
            </div>

            <div className="flex gap-2 border-t border-[color:var(--border)] px-3 py-3">
              <button
                type="button"
                onClick={() => void toggle(current)}
                className="rounded-md border border-[color:var(--border)] px-2.5 py-1 text-[11.5px] text-[color:var(--muted)] hover:text-[color:var(--fg)]"
              >
                {current.enabled ? 'Pause' : 'Resume'}
              </button>
              <button
                type="button"
                onClick={() => void remove(current)}
                className="rounded-md border border-[color:var(--danger-border)] px-2.5 py-1 text-[11.5px] text-[color:var(--danger)] hover:bg-[var(--danger-bg)]"
              >
                Delete trigger
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
