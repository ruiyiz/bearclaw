'use client';

import dagre from '@dagrejs/dagre';
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';

import type { WorkflowDefinition } from '@/lib/api';

const NODE_W = 190;
const NODE_H = 56;

export type NodeStatus =
  | 'succeeded'
  | 'failed'
  | 'running'
  | 'waiting'
  | 'skipped'
  | 'interrupted'
  | 'idle';

const STATUS_STYLE: Record<NodeStatus, { border: string; bg: string }> = {
  succeeded: { border: '#3fa06b', bg: 'rgba(63,160,107,0.12)' },
  failed: { border: '#d05353', bg: 'rgba(208,83,83,0.12)' },
  running: { border: '#4a8fd4', bg: 'rgba(74,143,212,0.14)' },
  waiting: { border: '#d1a03a', bg: 'rgba(209,160,58,0.14)' },
  skipped: { border: 'var(--border)', bg: 'transparent' },
  interrupted: { border: '#d1a03a', bg: 'rgba(209,160,58,0.10)' },
  idle: { border: 'var(--border)', bg: 'var(--card)' },
};

// LLM nodes and human waits read differently from the deterministic ones, so
// the shape carries that distinction the way the design doc's diagram does.
function shapeFor(type: string): string {
  if (type === 'agent') return '999px';
  if (type === 'human') return '4px';
  return '8px';
}

export function layoutGraph(
  def: WorkflowDefinition,
  statuses: Record<string, NodeStatus> = {},
  selected?: string | null,
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 28, ranksep: 52 });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = Object.keys(def.nodes ?? {});
  for (const id of ids) g.setNode(id, { width: NODE_W, height: NODE_H });
  for (const e of def.edges ?? []) {
    if (def.nodes[e.from] && def.nodes[e.to]) g.setEdge(e.from, e.to);
  }
  dagre.layout(g);

  const nodes: Node[] = ids.map((id) => {
    const node = def.nodes[id];
    const status = statuses[id] ?? 'idle';
    const style = STATUS_STYLE[status];
    const placed = def.layout?.[id] ?? g.node(id);
    return {
      id,
      position: {
        x: (placed?.x ?? 0) - NODE_W / 2,
        y: (placed?.y ?? 0) - NODE_H / 2,
      },
      data: { label: `${id}\n${node.type}` },
      draggable: false,
      style: {
        width: NODE_W,
        height: NODE_H,
        borderRadius: shapeFor(node.type),
        border: `${selected === id ? 2 : 1}px solid ${
          selected === id ? 'var(--accent)' : style.border
        }`,
        background: style.bg,
        color: 'var(--fg)',
        fontSize: 12,
        whiteSpace: 'pre-line',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: 4,
      },
    };
  });

  const edges: Edge[] = (def.edges ?? [])
    .filter((e) => def.nodes[e.from] && def.nodes[e.to])
    .map((e, i) => ({
      id: `${e.from}-${e.port}-${e.to}-${i}`,
      source: e.from,
      target: e.to,
      label: e.port === 'success' ? undefined : e.port,
      animated: statuses[e.from] === 'running',
      style: {
        stroke: e.port === 'error' ? '#d05353' : 'var(--border)',
        strokeWidth: 1.5,
      },
      labelStyle: { fill: 'var(--muted)', fontSize: 10 },
      labelBgStyle: { fill: 'var(--bg)' },
    }));

  return { nodes, edges };
}

export function WorkflowGraph({
  definition,
  statuses,
  selected,
  onSelect,
  height = 420,
}: {
  definition: WorkflowDefinition;
  statuses?: Record<string, NodeStatus>;
  selected?: string | null;
  onSelect?: (nodeId: string) => void;
  height?: number;
}) {
  const { nodes, edges } = useMemo(
    () => layoutGraph(definition, statuses ?? {}, selected),
    [definition, statuses, selected],
  );

  return (
    <div
      style={{ height }}
      className="rounded-lg border border-[color:var(--border)] overflow-hidden"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        nodesDraggable={false}
        onNodeClick={(_e, node) => onSelect?.(node.id)}
      >
        <Background gap={18} color="var(--border)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
