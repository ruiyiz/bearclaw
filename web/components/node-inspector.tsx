'use client';

import { useEffect, useMemo, useState } from 'react';

import { TagChip } from '@/components/tag-chip';
import type { WorkflowDefinition, WorkflowNodeDef } from '@/lib/api';
import {
  EXEC_FIELDS,
  NODE_FIELDS,
  NODE_TYPES,
  lookOf,
  type FieldSpec,
  type NodeType,
} from '@/lib/workflow-nodes';

function getPath(node: WorkflowNodeDef, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, k) =>
        acc && typeof acc === 'object'
          ? (acc as Record<string, unknown>)[k]
          : undefined,
      node,
    );
}

function setPath(
  node: WorkflowNodeDef,
  path: string,
  value: unknown,
): WorkflowNodeDef {
  const keys = path.split('.');
  const next = { ...node } as Record<string, unknown>;
  let cursor = next;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i];
    const child = cursor[k];
    cursor[k] =
      child && typeof child === 'object' ? { ...(child as object) } : {};
    cursor = cursor[k] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (value === undefined || value === '') delete cursor[last];
  else cursor[last] = value;
  // An empty retry object is noise in the file.
  const retry = next.retry as Record<string, unknown> | undefined;
  if (retry && Object.keys(retry).length === 0) delete next.retry;
  return next as WorkflowNodeDef;
}

const label = 'font-mono text-[10.5px] text-[color:var(--muted)] mb-1 block';
const control =
  'w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1.5 font-mono text-[11.5px] text-[color:var(--fg)] outline-none focus:border-[color:var(--accent)]';

function Field({
  spec,
  node,
  onChange,
}: {
  spec: FieldSpec;
  node: WorkflowNodeDef;
  onChange: (value: unknown) => void;
}) {
  const raw = getPath(node, spec.key);
  const [draft, setDraft] = useState<string>('');
  const [bad, setBad] = useState(false);

  const asText =
    spec.kind === 'json'
      ? raw === undefined
        ? ''
        : JSON.stringify(raw, null, 2)
      : spec.kind === 'list'
        ? Array.isArray(raw)
          ? (raw as string[]).join(', ')
          : ''
        : raw === undefined || raw === null
          ? ''
          : String(raw);

  useEffect(() => {
    setDraft(asText);
    setBad(false);
    // Re-seed only when the node or the field identity changes; typing keeps
    // its own draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.__id, spec.key]);

  const value = spec.kind === 'json' || spec.kind === 'list' ? draft : asText;

  if (spec.kind === 'boolean') {
    const on = raw === true;
    return (
      <button
        type="button"
        onClick={() => onChange(!on)}
        className="flex items-center gap-2.5 text-left"
      >
        <span
          className="relative h-[17px] w-[30px] shrink-0 rounded-full transition-colors"
          style={{ background: on ? 'var(--accent)' : 'var(--border)' }}
        >
          <span
            className="absolute top-[2px] h-[13px] w-[13px] rounded-full transition-all"
            style={{
              left: on ? 15 : 2,
              background: on ? 'var(--bg)' : 'var(--muted)',
            }}
          />
        </span>
        <span className="font-mono text-[11px] text-[color:var(--muted)]">
          {spec.key}: {on ? 'true' : 'false'}
        </span>
      </button>
    );
  }

  if (spec.kind === 'enum') {
    const options = spec.options ?? [];
    const current = String(raw ?? options[0] ?? '');
    return (
      <div>
        <span className={label}>{spec.key}</span>
        <div className="flex flex-wrap gap-1">
          {options.map((o) => (
            <button
              key={o || '(unset)'}
              type="button"
              onClick={() => onChange(o === '' ? undefined : o)}
              className="rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors"
              style={{
                borderColor: current === o ? 'var(--accent)' : 'var(--border)',
                color: current === o ? 'var(--fg)' : 'var(--muted)',
              }}
            >
              {o === '' ? 'unset' : o}
            </button>
          ))}
        </div>
        {spec.hint && (
          <p className="mt-1 text-[10.5px] text-[color:var(--muted)]">
            {spec.hint}
          </p>
        )}
      </div>
    );
  }

  const commit = (text: string) => {
    setDraft(text);
    if (spec.kind === 'json') {
      if (text.trim() === '') {
        setBad(false);
        onChange(undefined);
        return;
      }
      try {
        onChange(JSON.parse(text));
        setBad(false);
      } catch {
        setBad(true);
      }
      return;
    }
    if (spec.kind === 'list') {
      const items = text
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      onChange(items.length ? items : undefined);
      return;
    }
    if (spec.kind === 'number') {
      if (text.trim() === '') return onChange(undefined);
      const n = Number(text);
      if (Number.isFinite(n)) onChange(n);
      return;
    }
    onChange(text);
  };

  const multiline = spec.kind === 'area' || spec.kind === 'json';
  return (
    <div>
      <span className={label}>{spec.key}</span>
      {multiline ? (
        <textarea
          value={value}
          rows={String(value).length > 90 ? 5 : 3}
          placeholder={spec.placeholder}
          onChange={(e) => commit(e.target.value)}
          className={`${control} resize-y leading-relaxed`}
          style={bad ? { borderColor: 'var(--danger)' } : undefined}
        />
      ) : (
        <input
          value={value}
          placeholder={spec.placeholder}
          inputMode={spec.kind === 'number' ? 'numeric' : undefined}
          onChange={(e) => commit(e.target.value)}
          className={control}
        />
      )}
      {bad && (
        <p className="mt-1 text-[10.5px] text-[color:var(--danger)]">
          not valid JSON yet
        </p>
      )}
      {spec.hint && !bad && (
        <p className="mt-1 text-[10.5px] text-[color:var(--muted)]">
          {spec.hint}
        </p>
      )}
    </div>
  );
}

export function NodeInspector({
  definition,
  nodeId,
  onPatch,
  onRename,
  onRetype,
  onDuplicate,
  onDelete,
  onDeleteEdge,
  onSelect,
}: {
  definition: WorkflowDefinition;
  nodeId: string;
  onPatch: (id: string, node: WorkflowNodeDef) => void;
  onRename: (id: string, next: string) => void;
  onRetype: (id: string, type: NodeType) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onDeleteEdge: (from: string, port: string, to: string) => void;
  onSelect: (id: string) => void;
}) {
  const node = definition.nodes[nodeId];
  const [typeMenu, setTypeMenu] = useState(false);
  const [idDraft, setIdDraft] = useState(nodeId);
  useEffect(() => setIdDraft(nodeId), [nodeId]);

  const conns = useMemo(() => {
    const out = (definition.edges ?? []).filter((e) => e.from === nodeId);
    const inc = (definition.edges ?? []).filter((e) => e.to === nodeId);
    return [
      ...inc.map((e) => ({ ...e, dir: 'in' as const })),
      ...out.map((e) => ({ ...e, dir: 'out' as const })),
    ];
  }, [definition.edges, nodeId]);

  if (!node) return null;
  const look = lookOf(node.type);
  const specs = NODE_FIELDS[node.type as NodeType] ?? [];
  // Field remembers its draft per node; this key changes when the node does.
  const keyed = { ...node, __id: nodeId } as WorkflowNodeDef;

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]">
      <div className="flex items-center gap-2 border-b border-[color:var(--border)] bg-[color:var(--bg-2)] px-3 py-2.5">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: look.dot }}
        />
        <input
          value={idDraft}
          onChange={(e) => setIdDraft(e.target.value)}
          onBlur={() => {
            const clean = idDraft.replace(/[^A-Za-z0-9_]/g, '');
            if (clean && clean !== nodeId) onRename(nodeId, clean);
            else setIdDraft(nodeId);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          className="min-w-0 grow rounded-md bg-transparent px-1 py-0.5 font-mono text-[12.5px] outline-none focus:bg-[color:var(--bg)]"
        />
        <button
          type="button"
          onClick={() => setTypeMenu((v) => !v)}
          className="shrink-0 rounded-md border border-[color:var(--border)] px-2 py-0.5 font-mono text-[11px] text-[color:var(--muted)] hover:text-[color:var(--fg)]"
        >
          {node.type} ▾
        </button>
      </div>

      {typeMenu && (
        <div className="flex flex-wrap gap-1 border-b border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2.5">
          {NODE_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setTypeMenu(false);
                if (t !== node.type) onRetype(nodeId, t);
              }}
              className="rounded-md border px-2 py-0.5 font-mono text-[11px]"
              style={{
                borderColor:
                  t === node.type ? 'var(--accent)' : 'var(--border)',
                color: t === node.type ? 'var(--fg)' : 'var(--muted)',
              }}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      <div className="flex max-h-[38vh] flex-col gap-3 overflow-y-auto px-3 py-3">
        {specs.map((spec) => (
          <Field
            key={spec.key}
            spec={spec}
            node={keyed}
            onChange={(v) => onPatch(nodeId, setPath(node, spec.key, v))}
          />
        ))}
      </div>

      <div className="flex flex-col gap-3 border-t border-[color:var(--border)] px-3 py-3">
        <span className="text-[10.5px] uppercase tracking-wider text-[color:var(--muted)]">
          Execution
        </span>
        {EXEC_FIELDS.map((spec) => (
          <Field
            key={spec.key}
            spec={spec}
            node={keyed}
            onChange={(v) => onPatch(nodeId, setPath(node, spec.key, v))}
          />
        ))}
      </div>

      <div className="border-t border-[color:var(--border)] px-3 py-3">
        <span className="mb-2 block text-[10.5px] uppercase tracking-wider text-[color:var(--muted)]">
          Wires
        </span>
        {conns.length === 0 ? (
          <p className="text-[11.5px] text-[color:var(--muted)]">
            Nothing wired yet. Drag this node&rsquo;s port onto another node.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {conns.map((c) => (
              <li
                key={`${c.dir}${c.from}${c.port}${c.to}`}
                className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-[color:var(--bg-2)]"
              >
                <span className="shrink-0 rounded border border-[color:var(--border)] px-1 font-mono text-[10.5px] text-[color:var(--muted)]">
                  {c.port}
                </span>
                <button
                  type="button"
                  onClick={() => onSelect(c.dir === 'in' ? c.from : c.to)}
                  className="min-w-0 grow truncate text-left font-mono text-[11px] text-[color:var(--muted)] hover:text-[color:var(--fg)]"
                >
                  {c.dir === 'in' ? `${c.from} →` : `→ ${c.to}`}
                </button>
                <button
                  type="button"
                  aria-label="remove wire"
                  onClick={() => onDeleteEdge(c.from, c.port, c.to)}
                  className="shrink-0 rounded px-1 text-[color:var(--muted)] opacity-0 transition-opacity hover:text-[color:var(--fg)] group-hover:opacity-100"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex gap-2 border-t border-[color:var(--border)] px-3 py-3">
        <button
          type="button"
          onClick={() => onDuplicate(nodeId)}
          className="rounded-md border border-[color:var(--border)] px-2.5 py-1 text-[11.5px] text-[color:var(--muted)] hover:text-[color:var(--fg)]"
        >
          Duplicate
        </button>
        <button
          type="button"
          onClick={() => onDelete(nodeId)}
          className="rounded-md border border-[color:var(--danger-border)] px-2.5 py-1 text-[11.5px] text-[color:var(--danger)] hover:bg-[var(--danger-bg)]"
        >
          Delete node
        </button>
      </div>
    </div>
  );
}

export function WorkflowPanel({
  definition,
  onTags,
}: {
  definition: WorkflowDefinition;
  onTags?: (tags: string[]) => void;
}) {
  const policies = definition.policies ?? {};
  const inputs = definition.inputs?.properties ?? {};
  const alerts = (policies.alerts ?? {}) as Record<string, unknown>;
  const missed = alerts.on_missed as { expected_within?: string } | undefined;
  const rows: [string, string][] = [
    ['owner', definition.owner],
    ['concurrency', String(policies.concurrency ?? 'allow')],
    ['on failure', String(alerts.on_failure ?? '—')],
    ['on missed', missed?.expected_within ?? '—'],
  ];
  return (
    <div className="flex flex-col gap-3">
      <TagsCard definition={definition} onTags={onTags} />
      <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-3.5">
        <h3 className="mb-2 text-[10.5px] uppercase tracking-wider text-[color:var(--muted)]">
          Workflow
        </h3>
        <dl className="flex flex-col gap-1.5 text-[12px]">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-[color:var(--muted)]">{k}</dt>
              <dd className="truncate font-mono text-[11.5px]">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-3.5">
        <h3 className="mb-2 text-[10.5px] uppercase tracking-wider text-[color:var(--muted)]">
          Inputs
        </h3>
        {Object.keys(inputs).length === 0 ? (
          <p className="text-[11.5px] text-[color:var(--muted)]">
            No declared inputs.
          </p>
        ) : (
          <dl className="flex flex-col gap-1.5 text-[12px]">
            {Object.entries(inputs).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="font-mono text-[11.5px] text-[color:var(--muted)]">
                  {k}
                </dt>
                <dd className="truncate font-mono text-[11.5px]">
                  {v?.default === undefined
                    ? (v?.type ?? '')
                    : JSON.stringify(v.default)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-3.5">
        <h3 className="mb-2 text-[10.5px] uppercase tracking-wider text-[color:var(--muted)]">
          Legend
        </h3>
        <ul className="flex flex-col gap-2 text-[11.5px] text-[color:var(--muted)]">
          <li className="flex items-center gap-2.5">
            <span className="h-3 w-6 rounded-[3px] border border-[color:var(--border)]" />
            deterministic
          </li>
          <li className="flex items-center gap-2.5">
            <span className="h-3 w-6 rounded-full border border-[color:var(--border)]" />
            agent
          </li>
          <li className="flex items-center gap-2.5">
            <span className="h-3 w-6 rounded-[2px] border border-dashed border-[color:var(--warn)]" />
            human step
          </li>
          <li className="flex items-center gap-2.5">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: 'var(--accent)' }}
            />
            output port
          </li>
        </ul>
        <p className="mt-2.5 text-[11px] leading-relaxed text-[color:var(--muted)]">
          Click a node to edit it here. Click the canvas to come back.
        </p>
      </section>
    </div>
  );
}

// Tags live in the definition file, so they are saved by the same button as
// the graph: one file, one save.
function TagsCard({
  definition,
  onTags,
}: {
  definition: WorkflowDefinition;
  onTags?: (tags: string[]) => void;
}) {
  const tags = definition.tags ?? [];
  const [draft, setDraft] = useState('');

  const add = (raw: string) => {
    const clean = raw.trim().toLowerCase().replace(/^#/, '');
    setDraft('');
    if (!clean || tags.includes(clean) || tags.length >= 12) return;
    onTags?.([...tags, clean]);
  };

  return (
    <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-3.5">
      <h3 className="mb-2 text-[10.5px] uppercase tracking-wider text-[color:var(--muted)]">
        Tags
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => (
          <TagChip
            key={tag}
            tag={tag}
            onRemove={
              onTags ? () => onTags(tags.filter((x) => x !== tag)) : undefined
            }
          />
        ))}
        {tags.length === 0 && !onTags && (
          <span className="text-[11.5px] text-[color:var(--muted)]">
            No tags.
          </span>
        )}
      </div>
      {onTags && (
        <input
          value={draft}
          placeholder={tags.length >= 12 ? 'twelve is the limit' : 'add a tag…'}
          disabled={tags.length >= 12}
          onChange={(e) => {
            const v = e.target.value;
            if (v.endsWith(',')) add(v.slice(0, -1));
            else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add(draft);
            if (e.key === 'Backspace' && !draft && tags.length)
              onTags(tags.slice(0, -1));
          }}
          className="mt-2.5 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1.5 font-mono text-[11.5px] outline-none focus:border-[color:var(--accent)] disabled:opacity-50"
        />
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-[color:var(--muted)]">
        Tags group the list and filter it. They are part of the file, so they
        travel with the workflow.
      </p>
    </section>
  );
}
