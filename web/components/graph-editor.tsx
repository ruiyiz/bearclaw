'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { NodeInspector, WorkflowPanel } from '@/components/node-inspector';
import { WorkflowCanvas, positionsFor } from '@/components/workflow-canvas';
import { api, type WorkflowDefinition, type WorkflowNodeDef } from '@/lib/api';
import {
  NODE_DEFAULTS,
  PALETTE,
  checkGraph,
  freshNodeId,
  lookOf,
  portsOf,
  type NodeType,
} from '@/lib/workflow-nodes';

function clone(def: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(JSON.stringify(def)) as WorkflowDefinition;
}

export function GraphEditor({
  slug,
  definition,
  onSaved,
}: {
  slug: string;
  definition: WorkflowDefinition;
  onSaved: (def: WorkflowDefinition) => void;
}) {
  const [draft, setDraft] = useState<WorkflowDefinition>(() =>
    clone(definition),
  );
  const [dirty, setDirty] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A change landing from elsewhere (the file, another tab) replaces the draft
  // only while there is nothing of our own to lose.
  useEffect(() => {
    if (dirty === 0) setDraft(clone(definition));
  }, [definition, dirty]);

  const edit = useCallback((fn: (d: WorkflowDefinition) => void) => {
    setDraft((prev) => {
      const next = clone(prev);
      fn(next);
      return next;
    });
    setDirty((n) => n + 1);
    setError(null);
  }, []);

  const move = useCallback(
    (id: string, pos: { x: number; y: number }) =>
      edit((d) => {
        d.layout = { ...(d.layout ?? {}), [id]: pos };
      }),
    [edit],
  );

  const connect = useCallback(
    (from: string, port: string, to: string) =>
      edit((d) => {
        d.edges = (d.edges ?? []).filter(
          (e) => !(e.from === from && e.port === port),
        );
        d.edges.push({ from, port, to });
      }),
    [edit],
  );

  const deleteEdge = useCallback(
    (from: string, port: string, to: string) =>
      edit((d) => {
        d.edges = (d.edges ?? []).filter(
          (e) => !(e.from === from && e.port === port && e.to === to),
        );
      }),
    [edit],
  );

  const addNode = useCallback(
    (type: NodeType, pos: { x: number; y: number }) => {
      const id = freshNodeId(type, new Set(Object.keys(draft.nodes ?? {})));
      edit((d) => {
        d.nodes[id] = { type, ...NODE_DEFAULTS[type] } as WorkflowNodeDef;
        d.layout = { ...(d.layout ?? {}), [id]: pos };
      });
      setSelected(id);
    },
    [draft.nodes, edit],
  );

  const patch = useCallback(
    (id: string, node: WorkflowNodeDef) =>
      edit((d) => {
        d.nodes[id] = node;
      }),
    [edit],
  );

  const rename = useCallback(
    (id: string, next: string) => {
      if (draft.nodes[next]) return;
      edit((d) => {
        const entries = Object.entries(d.nodes).map(([k, v]) =>
          k === id ? [next, v] : [k, v],
        );
        d.nodes = Object.fromEntries(entries) as Record<
          string,
          WorkflowNodeDef
        >;
        d.edges = (d.edges ?? []).map((e) => ({
          from: e.from === id ? next : e.from,
          to: e.to === id ? next : e.to,
          port: e.port,
        }));
        if (d.layout?.[id]) {
          d.layout[next] = d.layout[id];
          delete d.layout[id];
        }
      });
      setSelected(next);
    },
    [draft.nodes, edit],
  );

  const retype = useCallback(
    (id: string, type: NodeType) =>
      edit((d) => {
        d.nodes[id] = { type, ...NODE_DEFAULTS[type] } as WorkflowNodeDef;
        // Ports change with the type, so wires the new type cannot offer go.
        const ports = portsOf(d.nodes[id]);
        d.edges = (d.edges ?? []).filter(
          (e) => e.from !== id || ports.includes(e.port),
        );
      }),
    [edit],
  );

  const duplicate = useCallback(
    (id: string) => {
      const copy = freshNodeId(id, new Set(Object.keys(draft.nodes ?? {})));
      edit((d) => {
        d.nodes[copy] = JSON.parse(
          JSON.stringify(d.nodes[id]),
        ) as WorkflowNodeDef;
        const at = d.layout?.[id];
        if (at)
          d.layout = { ...d.layout, [copy]: { x: at.x + 40, y: at.y + 40 } };
      });
      setSelected(copy);
    },
    [draft.nodes, edit],
  );

  const remove = useCallback(
    (id: string) => {
      edit((d) => {
        delete d.nodes[id];
        d.edges = (d.edges ?? []).filter((e) => e.from !== id && e.to !== id);
        if (d.layout) delete d.layout[id];
      });
      setSelected(null);
    },
    [edit],
  );

  const issues = useMemo(() => checkGraph(draft), [draft]);
  const errors = issues.filter((i) => i.level === 'error');

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Positions dagre worked out are written down on the first save, so the
      // graph opens the same way next time.
      const body = clone(draft);
      body.layout = positionsFor(draft);
      const res = await api.saveWorkflow(slug, body);
      setDirty(0);
      setDraft(clone(res.definition as WorkflowDefinition));
      onSaved(res.definition as WorkflowDefinition);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const nodeCount = Object.keys(draft.nodes ?? {}).length;
  const edgeCount = (draft.edges ?? []).length;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span
          className="flex items-center gap-2 rounded-md border px-2.5 py-1 text-[11.5px]"
          style={{
            borderColor: errors.length
              ? 'var(--danger-border)'
              : 'var(--border)',
            background: errors.length ? 'var(--danger-bg)' : 'transparent',
            color: errors.length ? 'var(--danger)' : 'var(--ok)',
          }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{
              background: errors.length ? 'var(--danger)' : 'var(--ok)',
            }}
          />
          {errors.length
            ? `${errors.length} problem${errors.length === 1 ? '' : 's'}`
            : issues.length
              ? `valid · ${issues.length} note${issues.length === 1 ? '' : 's'}`
              : 'graph valid'}
        </span>
        <span className="font-mono text-[11.5px] text-[color:var(--muted)]">
          {nodeCount} node{nodeCount === 1 ? '' : 's'} · {edgeCount} wire
          {edgeCount === 1 ? '' : 's'}
        </span>
        <span className="grow" />
        {dirty === 0 ? (
          <span className="font-mono text-[11px] text-[color:var(--muted)]">
            saved to {slug}.json
          </span>
        ) : (
          <>
            <span className="text-[11.5px] text-[color:var(--warn)]">
              {dirty} unsaved change{dirty === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              onClick={() => {
                setDraft(clone(definition));
                setDirty(0);
                setError(null);
              }}
              className="rounded-md border border-[color:var(--border)] px-2.5 py-1 text-[11.5px] text-[color:var(--muted)] hover:text-[color:var(--fg)]"
            >
              Discard
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={save}
              className="rounded-md bg-[color:var(--accent)] px-3 py-1 text-[11.5px] font-medium text-[color:var(--on-accent)] disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save to file'}
            </button>
          </>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-[color:var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-[11.5px] text-[color:var(--danger)]">
          {error}
        </p>
      )}

      {issues.length > 0 && (
        <div
          className="overflow-hidden rounded-lg border"
          style={{
            borderColor: errors.length
              ? 'var(--danger-border)'
              : 'var(--warn-border)',
            background: errors.length ? 'var(--danger-bg)' : 'var(--warn-bg)',
          }}
        >
          <div
            className="flex flex-wrap items-center gap-2 border-b px-3.5 py-2"
            style={{
              borderColor: errors.length
                ? 'var(--danger-border)'
                : 'var(--warn-border)',
            }}
          >
            <span
              className="text-[11px] uppercase tracking-wider"
              style={{ color: errors.length ? 'var(--danger)' : 'var(--warn)' }}
            >
              {errors.length ? 'Will not load' : 'Worth a look'}
            </span>
            <span className="text-[11px] text-[color:var(--muted)]">
              checked on every save, exactly as the loader checks the file
            </span>
          </div>
          <ul>
            {issues.map((i, n) => (
              <li key={`${i.node}${n}`}>
                <button
                  type="button"
                  onClick={() => setSelected(i.node)}
                  className="flex w-full items-baseline gap-2.5 px-3.5 py-2 text-left hover:bg-black/20"
                >
                  <span
                    className="font-mono text-[11px]"
                    style={{
                      color:
                        i.level === 'error' ? 'var(--danger)' : 'var(--warn)',
                    }}
                  >
                    {i.node}
                  </span>
                  <span className="text-[11.5px] text-[color:var(--muted)]">
                    {i.text}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-col gap-3 lg:flex-row">
        <aside className="shrink-0 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-2.5 lg:w-[150px]">
          <h3 className="mb-2 text-[10.5px] uppercase tracking-wider text-[color:var(--muted)]">
            Add a node
          </h3>
          <div className="flex flex-wrap gap-1.5 lg:flex-col">
            {PALETTE.map((type) => (
              <button
                key={type}
                type="button"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/bearclaw-node', type);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => addNode(type, { x: 40, y: 40 })}
                className="flex cursor-grab items-center gap-2 rounded-md border border-[color:var(--border)] bg-[color:var(--bg-2)] px-2 py-1 hover:border-[color:var(--muted)]"
                style={{
                  borderRadius: lookOf(type).radius === '999px' ? 999 : 6,
                }}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: lookOf(type).dot }}
                />
                <span className="font-mono text-[11px]">{type}</span>
              </button>
            ))}
          </div>
          <p className="mt-2.5 border-t border-[color:var(--border)] pt-2.5 text-[10.5px] leading-relaxed text-[color:var(--muted)]">
            Drag one onto the canvas. Drag a node to move it, drag a port to
            wire it to the next node.
          </p>
        </aside>

        <div className="min-w-0 grow">
          <WorkflowCanvas
            definition={draft}
            selected={selected}
            onSelect={setSelected}
            editable
            onMove={move}
            onConnect={connect}
            onDropType={addNode}
            onDeleteEdge={deleteEdge}
            height="min(68vh, 640px)"
          />
        </div>

        <div className="shrink-0 lg:w-[316px]">
          {selected && draft.nodes[selected] ? (
            <NodeInspector
              definition={draft}
              nodeId={selected}
              onPatch={patch}
              onRename={rename}
              onRetype={retype}
              onDuplicate={duplicate}
              onDelete={remove}
              onDeleteEdge={deleteEdge}
              onSelect={setSelected}
            />
          ) : (
            <WorkflowPanel
              definition={draft}
              onTags={(tags) =>
                edit((d) => {
                  d.tags = tags;
                })
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
