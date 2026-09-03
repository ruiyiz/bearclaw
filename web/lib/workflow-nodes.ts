// What the editor knows about node types: the ports the engine will give
// them, the fields it may edit, and what a fresh one starts as. Kept in step
// with src/workflows/schema.ts by hand — the server is still the authority and
// rejects anything this file gets wrong.
import type { WorkflowDefinition, WorkflowNodeDef } from '@/lib/api';

export const DEFAULT_PORT = 'success';
export const ERROR_PORT = 'error';

export type NodeType =
  | 'agent'
  | 'shell'
  | 'http'
  | 'template'
  | 'transform'
  | 'condition'
  | 'switch'
  | 'send'
  | 'human'
  | 'wait_event'
  | 'emit'
  | 'delay'
  | 'workflow'
  | 'map';

export type FieldKind =
  | 'text'
  | 'area'
  | 'enum'
  | 'number'
  | 'boolean'
  | 'json'
  | 'list';

export interface FieldSpec {
  key: string;
  kind: FieldKind;
  options?: string[];
  placeholder?: string;
  hint?: string;
}

const F = (
  key: string,
  kind: FieldKind,
  extra: Omit<FieldSpec, 'key' | 'kind'> = {},
): FieldSpec => ({ key, kind, ...extra });

export const NODE_FIELDS: Record<NodeType, FieldSpec[]> = {
  agent: [
    F('prompt', 'area', { placeholder: 'What should the agent do?' }),
    F('model', 'text', { placeholder: 'sonnet' }),
    F('effort', 'enum', {
      options: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
    }),
    F('session', 'enum', { options: ['fresh', 'run', 'chat'] }),
    F('max_turns', 'number'),
    F('allowed_tools', 'list', { placeholder: 'Read, Bash' }),
    F('output_schema', 'json', { hint: 'must be an object schema' }),
  ],
  shell: [
    F('cmd', 'area', { placeholder: 'echo hello' }),
    F('parse', 'enum', { options: ['text', 'json', 'lines'] }),
    F('cwd', 'text', { placeholder: '~' }),
    F('stdin', 'area'),
    F('env', 'json'),
  ],
  http: [
    F('url', 'text', { placeholder: 'https://' }),
    F('method', 'enum', {
      options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    }),
    F('headers', 'json'),
    F('body', 'area'),
    F('parse', 'enum', { options: ['json', 'text', 'lines'] }),
  ],
  template: [F('template', 'area'), F('file', 'text')],
  transform: [F('expr', 'area', { placeholder: 'nodes.previous.output' })],
  condition: [
    F('expr', 'area', { placeholder: 'nodes.previous.output.length > 0' }),
  ],
  switch: [
    F('expr', 'area'),
    F('cases', 'list', { placeholder: 'save, skip' }),
  ],
  send: [
    F('text', 'area'),
    F('to', 'text', { placeholder: '{{ inputs.to }}' }),
  ],
  human: [
    F('kind', 'enum', { options: ['input', 'choice', 'approve'] }),
    F('prompt', 'area'),
    F('to', 'list', { placeholder: 'email:main' }),
    F('options', 'list', { hint: 'choice only — one port per option' }),
    F('expires', 'text', { placeholder: '3d' }),
    F('notify', 'boolean', {
      hint: 'off when the workflow already said how to answer',
    }),
  ],
  wait_event: [
    F('event', 'text', { placeholder: 'email_received' }),
    F('filter', 'json'),
    F('lookback', 'text', { placeholder: '24h' }),
  ],
  emit: [F('event', 'text'), F('payload', 'json')],
  delay: [
    F('duration', 'text', { placeholder: '10m' }),
    F('until', 'text', { placeholder: '2026-09-10T09:00' }),
  ],
  workflow: [F('slug', 'text'), F('inputs', 'json')],
  map: [
    F('over', 'text', { placeholder: 'nodes.previous.output' }),
    F('concurrency', 'number'),
    F('node', 'json', { hint: 'the node run once per item' }),
  ],
};

// Every node type carries these as well; they are grouped apart in the panel
// because they are about running the node, not about what it does.
export const EXEC_FIELDS: FieldSpec[] = [
  F('retry.max', 'number', { placeholder: '0' }),
  F('retry.backoff', 'text', { placeholder: '30s' }),
  F('timeout', 'text', { placeholder: '2m' }),
  F('agent', 'text', { hint: 'runs as this agent instead of the owner' }),
];

export const NODE_DEFAULTS: Record<NodeType, Record<string, unknown>> = {
  agent: { prompt: 'What should happen here?', session: 'fresh' },
  shell: { cmd: 'echo hello', parse: 'text' },
  http: { url: 'https://', method: 'GET', parse: 'json' },
  template: { template: '{{ inputs.text }}' },
  transform: { expr: 'inputs' },
  condition: { expr: 'true' },
  switch: { expr: 'inputs.kind', cases: ['a', 'b'] },
  send: { text: '{{ inputs.text }}' },
  human: { kind: 'input', prompt: 'What should I do?', expires: '3d' },
  wait_event: { event: 'email_received' },
  emit: { event: 'workflow.custom' },
  delay: { duration: '10m' },
  workflow: { slug: '' },
  map: {
    over: 'inputs.items',
    node: { type: 'shell', cmd: 'echo {{ item }}' },
  },
};

export const NODE_TYPES = Object.keys(NODE_FIELDS) as NodeType[];

// The palette leads with what a workflow is usually made of; the rest are a
// click away in the type picker.
export const PALETTE: NodeType[] = [
  'agent',
  'shell',
  'http',
  'transform',
  'condition',
  'switch',
  'send',
  'human',
  'wait_event',
  'delay',
];

export function portsOf(node: WorkflowNodeDef | undefined): string[] {
  if (!node) return [DEFAULT_PORT, ERROR_PORT];
  switch (node.type) {
    case 'condition':
      return ['true', 'false', ERROR_PORT];
    case 'switch': {
      const cases = Array.isArray(node.cases) ? (node.cases as string[]) : [];
      return [...cases, 'default', ERROR_PORT];
    }
    case 'human':
      if (node.kind === 'approve')
        return ['approved', 'rejected', 'timeout', ERROR_PORT];
      if (node.kind === 'choice')
        return [
          ...((node.options as string[] | undefined) ?? []),
          'timeout',
          ERROR_PORT,
        ];
      return ['submitted', 'timeout', ERROR_PORT];
    case 'wait_event':
      return ['received', 'timeout', ERROR_PORT];
    default:
      return [DEFAULT_PORT, ERROR_PORT];
  }
}

export interface TypeLook {
  dot: string;
  radius: string;
  label: string;
}

const AGENT_DOT = 'var(--accent)';
export const TYPE_LOOK: Record<string, TypeLook> = {
  agent: { dot: AGENT_DOT, radius: '999px', label: 'agent' },
  shell: { dot: '#6f8fa8', radius: '8px', label: 'shell' },
  http: { dot: '#6f8fa8', radius: '8px', label: 'http' },
  template: { dot: '#6f8fa8', radius: '8px', label: 'template' },
  transform: { dot: '#6f8fa8', radius: '8px', label: 'transform' },
  condition: { dot: '#8f7ad6', radius: '8px', label: 'condition' },
  switch: { dot: '#8f7ad6', radius: '8px', label: 'switch' },
  map: { dot: '#8f7ad6', radius: '8px', label: 'map' },
  workflow: { dot: '#8f7ad6', radius: '8px', label: 'workflow' },
  send: { dot: '#69a95e', radius: '8px', label: 'send' },
  emit: { dot: '#69a95e', radius: '8px', label: 'emit' },
  human: { dot: '#c2984f', radius: '3px', label: 'human' },
  wait_event: { dot: '#c2984f', radius: '3px', label: 'wait_event' },
  delay: { dot: '#5b6169', radius: '8px', label: 'delay' },
};

export function lookOf(type: string): TypeLook {
  return TYPE_LOOK[type] ?? TYPE_LOOK.shell;
}

// A one-line summary for the node body: the first field that says what it
// does, trimmed to fit.
export function summaryOf(node: WorkflowNodeDef): string {
  const first = (NODE_FIELDS[node.type as NodeType] ?? [])[0];
  const raw = first ? node[first.key] : undefined;
  if (raw === undefined || raw === null) return '';
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return text.split('\n')[0].slice(0, 60);
}

export interface GraphIssue {
  node: string;
  level: 'error' | 'info';
  text: string;
}

function refsIn(node: WorkflowNodeDef): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(/\bnodes\.([A-Za-z_$][\w$]*)/g))
        found.add(m[1]);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object')
      Object.values(value).forEach(walk);
  };
  walk(node);
  return [...found];
}

// The checks the loader runs, run here on every keystroke so a hole shows up
// before the file is written rather than after.
export function checkGraph(def: WorkflowDefinition): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const ids = Object.keys(def.nodes ?? {});
  const known = new Set(ids);
  const parents: Record<string, string[]> = {};
  for (const id of ids) parents[id] = [];
  const incoming = new Set<string>();

  for (const e of def.edges ?? []) {
    if (!known.has(e.from))
      issues.push({
        node: e.from || '(edge)',
        level: 'error',
        text: `an edge starts at "${e.from}", which does not exist`,
      });
    if (!known.has(e.to))
      issues.push({
        node: e.from || '(edge)',
        level: 'error',
        text: `an edge ends at "${e.to}", which does not exist`,
      });
    if (!known.has(e.from) || !known.has(e.to)) continue;
    const ports = portsOf(def.nodes[e.from]);
    if (!ports.includes(e.port))
      issues.push({
        node: e.from,
        level: 'error',
        text: `has no port "${e.port}" — it offers ${ports.join(', ')}`,
      });
    parents[e.to].push(e.from);
    incoming.add(e.to);
  }

  const upstreamOf = (id: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [...(parents[id] ?? [])];
    while (queue.length) {
      const p = queue.shift()!;
      if (seen.has(p)) continue;
      seen.add(p);
      for (const q of parents[p] ?? []) queue.push(q);
    }
    return seen;
  };

  for (const id of ids) {
    const up = upstreamOf(id);
    for (const ref of refsIn(def.nodes[id])) {
      if (ref === id || up.has(ref)) continue;
      issues.push({
        node: id,
        level: 'error',
        text: known.has(ref)
          ? `reads nodes.${ref}, which is not upstream of it — no wire reaches it from ${ref}`
          : `reads nodes.${ref}, which does not exist`,
      });
    }
  }

  const entries = ids.filter((id) => !incoming.has(id));
  if (entries.length > 1) {
    for (const id of entries.slice(1))
      issues.push({
        node: id,
        level: 'info',
        text: 'has nothing wired into it, so it starts a branch of its own',
      });
  }
  if (ids.length && entries.length === 0)
    issues.push({
      node: ids[0],
      level: 'error',
      text: 'every node has an incoming edge, so the graph has no entry',
    });

  return issues;
}

export function freshNodeId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}
