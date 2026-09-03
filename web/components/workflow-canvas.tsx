'use client';

import dagre from '@dagrejs/dagre';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { WorkflowDefinition, WorkflowNodeDef } from '@/lib/api';
import {
  ERROR_PORT,
  lookOf,
  portsOf,
  summaryOf,
  type NodeType,
} from '@/lib/workflow-nodes';

export const NODE_W = 196;
export const NODE_H = 48;

export type NodeStatus =
  | 'succeeded'
  | 'failed'
  | 'running'
  | 'waiting'
  | 'skipped'
  | 'interrupted'
  | 'idle';

const STATUS_STYLE: Record<NodeStatus, { border: string; bg: string }> = {
  succeeded: { border: 'var(--ok-border)', bg: 'rgba(63,160,107,0.10)' },
  failed: { border: 'var(--danger-border)', bg: 'rgba(208,83,83,0.12)' },
  running: { border: '#2f4a5c', bg: 'rgba(74,143,212,0.14)' },
  waiting: { border: 'var(--warn-border)', bg: 'rgba(209,160,58,0.14)' },
  skipped: { border: 'var(--border)', bg: 'transparent' },
  interrupted: { border: 'var(--warn-border)', bg: 'rgba(209,160,58,0.10)' },
  idle: { border: 'var(--border)', bg: 'var(--card)' },
};

const PORT_COLOR: Record<string, string> = {
  error: 'var(--danger)',
  false: '#7c848c',
  timeout: '#7c848c',
  rejected: 'var(--danger)',
};

function portColor(port: string): string {
  return PORT_COLOR[port] ?? 'var(--accent)';
}

interface CardData extends Record<string, unknown> {
  nodeId: string;
  type: string;
  summary: string;
  ports: string[];
  status: NodeStatus;
  selected: boolean;
  editable: boolean;
  duration: string;
}

function NodeCard({ data }: NodeProps) {
  const d = data as CardData;
  const look = lookOf(d.type);
  const style = STATUS_STYLE[d.status];
  return (
    <div
      className="wf-node"
      style={{
        width: NODE_W,
        height: NODE_H,
        borderRadius: look.radius,
        border: `1px solid ${d.selected ? 'var(--accent)' : style.border}`,
        background: style.bg === 'transparent' ? 'var(--card)' : style.bg,
        boxShadow: d.selected ? '0 0 0 3px var(--accent-soft)' : undefined,
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '0 11px',
        cursor: d.editable ? 'grab' : 'pointer',
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        id="in"
        isConnectable={d.editable}
        style={{
          width: 9,
          height: 9,
          background: 'var(--bg-2)',
          border: '1px solid var(--border)',
          opacity: d.editable ? 1 : 0,
        }}
      />
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: look.dot,
          flexShrink: 0,
        }}
      />
      <span className="min-w-0 grow">
        <span className="block truncate font-mono text-[11.5px] leading-tight">
          {d.nodeId}
        </span>
        <span className="block truncate text-[10px] leading-tight text-[color:var(--muted)]">
          {d.summary || d.type}
        </span>
      </span>
      {d.duration ? (
        <span className="shrink-0 font-mono text-[10px] text-[color:var(--muted)]">
          {d.duration}
        </span>
      ) : (
        <span className="shrink-0 text-[9px] uppercase tracking-wider text-[color:var(--muted)]">
          {d.type}
        </span>
      )}
      {d.ports.map((port, i) => (
        <Handle
          key={port}
          type="source"
          position={Position.Bottom}
          id={port}
          isConnectable={d.editable}
          title={port}
          style={{
            left: `${((i + 1) / (d.ports.length + 1)) * 100}%`,
            width: 9,
            height: 9,
            background: portColor(port),
            border: '1px solid var(--bg)',
            opacity: d.editable
              ? d.selected || d.ports.length > 2
                ? 1
                : 0.7
              : 0,
          }}
        />
      ))}
    </div>
  );
}

const NODE_TYPES = { wf: NodeCard };

// Positions come from the definition when it has them and from dagre when it
// does not, so a workflow written by hand still opens as a readable graph.
export function positionsFor(
  def: WorkflowDefinition,
): Record<string, { x: number; y: number }> {
  const ids = Object.keys(def.nodes ?? {});
  const missing = ids.filter((id) => !def.layout?.[id]);
  const out: Record<string, { x: number; y: number }> = {};
  for (const id of ids) if (def.layout?.[id]) out[id] = def.layout[id];
  if (!missing.length) return out;

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 34, ranksep: 56 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of ids) g.setNode(id, { width: NODE_W, height: NODE_H });
  for (const e of def.edges ?? [])
    if (def.nodes[e.from] && def.nodes[e.to]) g.setEdge(e.from, e.to);
  dagre.layout(g);
  for (const id of missing) {
    const p = g.node(id);
    out[id] = { x: (p?.x ?? 0) - NODE_W / 2, y: (p?.y ?? 0) - NODE_H / 2 };
  }
  return out;
}

function buildNodes(
  def: WorkflowDefinition,
  positions: Record<string, { x: number; y: number }>,
  statuses: Record<string, NodeStatus>,
  durations: Record<string, string>,
  selected: string | null,
  editable: boolean,
): Node[] {
  return Object.keys(def.nodes ?? {}).map((id) => ({
    id,
    type: 'wf',
    position: positions[id] ?? { x: 0, y: 0 },
    draggable: editable,
    selectable: true,
    data: {
      nodeId: id,
      type: def.nodes[id].type,
      summary: summaryOf(def.nodes[id]),
      ports: portsOf(def.nodes[id]),
      status: statuses[id] ?? 'idle',
      selected: selected === id,
      editable,
      duration: durations[id] ?? '',
    } satisfies CardData,
  }));
}

function buildEdges(
  def: WorkflowDefinition,
  statuses: Record<string, NodeStatus>,
  selected: string | null,
): Edge[] {
  return (def.edges ?? [])
    .filter((e) => def.nodes[e.from] && def.nodes[e.to])
    .map((e, i) => {
      const touched = selected === e.from || selected === e.to;
      const dead =
        statuses[e.from] === 'skipped' || statuses[e.to] === 'skipped';
      const stroke = touched
        ? 'var(--accent)'
        : e.port === ERROR_PORT
          ? 'var(--danger-border)'
          : dead
            ? 'var(--border)'
            : 'var(--wire)';
      return {
        id: `${e.from}|${e.port}|${e.to}|${i}`,
        source: e.from,
        target: e.to,
        sourceHandle: e.port,
        targetHandle: 'in',
        label: e.port === 'success' ? undefined : e.port,
        type: 'smoothstep',
        style: { stroke, strokeWidth: touched ? 1.8 : 1.4 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: stroke,
          width: 14,
          height: 14,
        },
        labelStyle: { fill: 'var(--muted)', fontSize: 10 },
        labelBgStyle: { fill: 'var(--bg-2)' },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4,
      } satisfies Edge;
    });
}

export interface CanvasProps {
  definition: WorkflowDefinition;
  statuses?: Record<string, NodeStatus>;
  durations?: Record<string, string>;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  editable?: boolean;
  /** Called when a node is dragged; positions are definition-space. */
  onMove?: (id: string, pos: { x: number; y: number }) => void;
  onConnect?: (from: string, port: string, to: string) => void;
  onDropType?: (type: NodeType, pos: { x: number; y: number }) => void;
  onDeleteEdge?: (from: string, port: string, to: string) => void;
  height?: number | string;
}

function Canvas({
  definition,
  statuses = {},
  durations = {},
  selected = null,
  onSelect,
  editable = false,
  onMove,
  onConnect,
  onDropType,
  onDeleteEdge,
  height = 560,
}: CanvasProps) {
  const positions = useMemo(() => positionsFor(definition), [definition]);
  const flow = useReactFlow();
  const [nodes, setNodes] = useState<Node[]>(() =>
    buildNodes(definition, positions, statuses, durations, selected, editable),
  );
  // The definition is the source of truth; local node state exists only so a
  // drag renders at 60fps before it is committed.
  const signature = useMemo(
    () =>
      JSON.stringify([
        Object.keys(definition.nodes ?? {}),
        Object.entries(definition.nodes ?? {}).map(([id, n]) => [
          id,
          n.type,
          summaryOf(n),
          portsOf(n),
        ]),
        positions,
        statuses,
        durations,
        selected,
        editable,
      ]),
    [definition, positions, statuses, durations, selected, editable],
  );
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (lastSignature.current === signature) return;
    lastSignature.current = signature;
    setNodes(
      buildNodes(
        definition,
        positions,
        statuses,
        durations,
        selected,
        editable,
      ),
    );
  }, [
    signature,
    definition,
    positions,
    statuses,
    durations,
    selected,
    editable,
  ]);

  const edges = useMemo(
    () => buildEdges(definition, statuses, selected),
    [definition, statuses, selected],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((prev) => applyNodeChanges(changes, prev));
      if (!editable || !onMove) return;
      for (const c of changes) {
        if (c.type === 'position' && c.dragging === false && c.position)
          onMove(c.id, {
            x: Math.round(c.position.x / 10) * 10,
            y: Math.round(c.position.y / 10) * 10,
          });
      }
    },
    [editable, onMove],
  );

  const connect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      onConnect?.(c.source, c.sourceHandle ?? 'success', c.target);
    },
    [onConnect],
  );

  const drop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer.getData('application/bearclaw-node');
      if (!type || !onDropType) return;
      const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      onDropType(type as NodeType, {
        x: Math.round((p.x - NODE_W / 2) / 10) * 10,
        y: Math.round((p.y - NODE_H / 2) / 10) * 10,
      });
    },
    [flow, onDropType],
  );

  return (
    <div
      style={{ height }}
      className="wf-canvas relative overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-2)]"
      onDragOver={(e) => {
        if (!onDropType) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={drop}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onConnect={connect}
        onEdgesDelete={(removed) => {
          for (const e of removed) {
            const [from, port, to] = e.id.split('|');
            onDeleteEdge?.(from, port, to);
          }
        }}
        onNodeClick={(_e, n) => onSelect?.(n.id)}
        onPaneClick={() => onSelect?.(null)}
        nodesConnectable={editable}
        nodesDraggable={editable}
        elementsSelectable
        deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
        connectionRadius={28}
        minZoom={0.55}
        maxZoom={1.6}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={22} size={1} color="var(--grid)" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </div>
  );
}

export function WorkflowCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

export function nodeStatusesFrom(
  steps: { nodeId: string; status: string }[],
  nodes: Record<string, WorkflowNodeDef>,
): Record<string, NodeStatus> {
  const out: Record<string, NodeStatus> = {};
  for (const id of Object.keys(nodes)) out[id] = 'idle';
  for (const s of steps) {
    const status = s.status as NodeStatus;
    out[s.nodeId] = status;
  }
  return out;
}
