import { z } from 'zod';

const jsonValue: z.ZodType<unknown> = z.unknown();

const retry = z.object({
  max: z.number().int().min(0).max(10),
  backoff: z.string().optional(),
});

const common = {
  name: z.string().optional(),
  description: z.string().optional(),
  agent: z.string().optional(),
  retry: retry.optional(),
  timeout: z.string().optional(),
};

const parseMode = z.enum(['json', 'text', 'lines']);

const agentNode = z.object({
  type: z.literal('agent'),
  prompt: z.string(),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  session: z.enum(['fresh', 'run', 'chat']).default('fresh'),
  max_turns: z.number().int().positive().optional(),
  allowed_tools: z.array(z.string()).optional(),
  approve_tools: z.array(z.string()).optional(),
  output_schema: jsonValue.optional(),
  ...common,
});

const shellNode = z.object({
  type: z.literal('shell'),
  cmd: z.string(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  stdin: z.string().optional(),
  parse: parseMode.default('text'),
  ...common,
});

const httpNode = z.object({
  type: z.literal('http'),
  url: z.string(),
  method: z.string().default('GET'),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.union([z.string(), z.record(z.string(), jsonValue)]).optional(),
  parse: parseMode.default('json'),
  ...common,
});

const templateNode = z.object({
  type: z.literal('template'),
  template: z.string().optional(),
  file: z.string().optional(),
  ...common,
});

const transformNode = z.object({
  type: z.literal('transform'),
  expr: z.string(),
  ...common,
});

const conditionNode = z.object({
  type: z.literal('condition'),
  expr: z.string(),
  ...common,
});

const switchNode = z.object({
  type: z.literal('switch'),
  expr: z.string(),
  cases: z.array(z.string()).min(1),
  ...common,
});

const sendNode = z.object({
  type: z.literal('send'),
  text: z.string(),
  to: z.string().optional(),
  media: z.array(z.string()).optional(),
  ...common,
});

const humanField = z.object({
  name: z.string(),
  label: z.string().optional(),
  type: z.enum(['text', 'number', 'boolean', 'select']).default('text'),
  options: z.array(z.string()).optional(),
  required: z.boolean().default(false),
});

const humanNode = z.object({
  type: z.literal('human'),
  kind: z.enum(['approve', 'choice', 'input']),
  prompt: z.string(),
  to: z.array(z.string()).optional(),
  options: z.array(z.string()).optional(),
  fields: z.array(humanField).optional(),
  expires: z.string().default('3d'),
  // Set false when the workflow has already told the user how to answer (a
  // digest email that ends with "reply with ..."), so opening the wait does
  // not send a second message.
  notify: z.boolean().default(true),
  on_timeout: z
    .union([
      z.enum(['approve', 'reject', 'skip', 'fail']),
      z.object({ value: jsonValue }),
    ])
    .optional(),
  ...common,
});

const waitEventNode = z.object({
  type: z.literal('wait_event'),
  event: z.string(),
  filter: z.record(z.string(), jsonValue).optional(),
  lookback: z.string().optional(),
  ...common,
});

const emitNode = z.object({
  type: z.literal('emit'),
  event: z.string(),
  payload: z.record(z.string(), jsonValue).optional(),
  ...common,
});

const delayNode = z.object({
  type: z.literal('delay'),
  duration: z.string().optional(),
  until: z.string().optional(),
  ...common,
});

const subWorkflowNode = z.object({
  type: z.literal('workflow'),
  slug: z.string(),
  inputs: z.record(z.string(), jsonValue).optional(),
  ...common,
});

const mapNode = z.object({
  type: z.literal('map'),
  over: z.string(),
  node: z.record(z.string(), jsonValue),
  concurrency: z.number().int().min(1).max(20).default(4),
  ...common,
});

export const nodeSchema = z.discriminatedUnion('type', [
  agentNode,
  shellNode,
  httpNode,
  templateNode,
  transformNode,
  conditionNode,
  switchNode,
  sendNode,
  humanNode,
  waitEventNode,
  emitNode,
  delayNode,
  subWorkflowNode,
  mapNode,
]);

export const edgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  port: z.string().default('success'),
});

export const triggerDeclSchema = z.object({
  id: z.string(),
  type: z.enum(['cron', 'event', 'manual', 'webhook', 'at']),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  quiet: z.object({ start: z.string(), end: z.string() }).optional(),
  catchup: z.enum(['skip', 'once', 'all']).default('skip'),
  event: z.string().optional(),
  filter: z.record(z.string(), jsonValue).optional(),
  map: z.record(z.string(), z.string()).optional(),
  at: z.string().optional(),
  args: z.record(z.string(), jsonValue).optional(),
  enabled: z.boolean().default(true),
});

export const policiesSchema = z.object({
  concurrency: z.enum(['allow', 'skip', 'queue', 'replace']).default('allow'),
  on_error: z.string().optional(),
  alerts: z
    .object({
      on_failure: z.string().optional(),
      on_missed: z
        .object({ trigger: z.string(), expected_within: z.string() })
        .optional(),
    })
    .optional(),
  retention: z
    .object({
      runs: z.number().int().positive().optional(),
      days: z.number().int().positive().optional(),
    })
    .optional(),
});

export const definitionSchema = z.object({
  $schema: z.string().optional(),
  name: z.string(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  owner: z.string(),
  description: z.string().optional(),
  inputs: z
    .object({
      type: z.literal('object').default('object'),
      required: z.array(z.string()).optional(),
      properties: z.record(z.string(), jsonValue).default({}),
    })
    .optional(),
  triggers: z.array(triggerDeclSchema).default([]),
  policies: policiesSchema.prefault({}),
  layout: z
    .record(z.string(), z.object({ x: z.number(), y: z.number() }))
    .optional(),
  nodes: z.record(z.string(), nodeSchema),
  edges: z.array(edgeSchema).default([]),
});

export type WorkflowNode = z.infer<typeof nodeSchema>;
export type WorkflowEdge = z.infer<typeof edgeSchema>;
export type TriggerDecl = z.infer<typeof triggerDeclSchema>;
export type WorkflowPolicies = z.infer<typeof policiesSchema>;
export type WorkflowDefinition = z.infer<typeof definitionSchema>;
export type NodeType = WorkflowNode['type'];

export const DEFAULT_PORT = 'success';
export const ERROR_PORT = 'error';

export function portsOf(node: WorkflowNode): string[] {
  switch (node.type) {
    case 'condition':
      return ['true', 'false', ERROR_PORT];
    case 'switch':
      return [...node.cases, 'default', ERROR_PORT];
    case 'human':
      if (node.kind === 'approve')
        return ['approved', 'rejected', 'timeout', ERROR_PORT];
      if (node.kind === 'choice')
        return [...(node.options ?? []), 'timeout', ERROR_PORT];
      return ['submitted', 'timeout', ERROR_PORT];
    case 'wait_event':
      return ['received', 'timeout', ERROR_PORT];
    default:
      return [DEFAULT_PORT, ERROR_PORT];
  }
}

export class WorkflowValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}

// Structural checks the zod schema cannot express: edge endpoints resolve,
// ports exist on their source node, the graph is acyclic, and every node is
// reachable from an entry node.
export function checkGraph(def: WorkflowDefinition): string[] {
  const issues: string[] = [];
  const ids = new Set(Object.keys(def.nodes));
  if (ids.size === 0) issues.push('workflow has no nodes');

  const seen = new Set<string>();
  for (const e of def.edges) {
    if (!ids.has(e.from)) issues.push(`edge from unknown node "${e.from}"`);
    if (!ids.has(e.to)) issues.push(`edge to unknown node "${e.to}"`);
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    const ports = portsOf(def.nodes[e.from]);
    if (!ports.includes(e.port))
      issues.push(
        `node "${e.from}" has no port "${e.port}" (has ${ports.join(', ')})`,
      );
    const key = `${e.from}|${e.port}|${e.to}`;
    if (seen.has(key)) issues.push(`duplicate edge ${key}`);
    seen.add(key);
  }

  const outgoing = new Map<string, string[]>();
  for (const id of ids) outgoing.set(id, []);
  for (const e of def.edges) {
    if (ids.has(e.from) && ids.has(e.to)) outgoing.get(e.from)!.push(e.to);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    const s = state.get(id) ?? 0;
    if (s === 2) return;
    if (s === 1) {
      const at = stack.indexOf(id);
      issues.push(`cycle: ${[...stack.slice(at), id].join(' -> ')}`);
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const next of outgoing.get(id) ?? []) visit(next);
    stack.pop();
    state.set(id, 2);
  };
  for (const id of ids) visit(id);

  const hasIncoming = new Set(def.edges.map((e) => e.to));
  const entries = [...ids].filter((id) => !hasIncoming.has(id));
  if (entries.length === 0 && ids.size > 0)
    issues.push('no entry node (every node has an incoming edge)');

  const reachable = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const next of outgoing.get(id) ?? []) queue.push(next);
  }
  for (const id of ids)
    if (!reachable.has(id)) issues.push(`node "${id}" is unreachable`);

  for (const [id, node] of Object.entries(def.nodes)) {
    if (node.type === 'template' && !node.template && !node.file)
      issues.push(`template node "${id}" needs template or file`);
    if (node.type === 'delay' && !node.duration && !node.until)
      issues.push(`delay node "${id}" needs duration or until`);
    if (
      node.type === 'human' &&
      node.kind === 'choice' &&
      !node.options?.length
    )
      issues.push(`human node "${id}" of kind choice needs options`);
    if (node.type === 'agent' && node.output_schema !== undefined) {
      // The SDK exposes the schema as a tool's input_schema, and the API
      // requires that to be an object. A bare array 400s at request time.
      const schema = node.output_schema as { type?: unknown } | null;
      if (!schema || typeof schema !== 'object' || schema.type !== 'object')
        issues.push(
          `agent node "${id}" needs an output_schema of type "object" (wrap an array in a named property)`,
        );
    }
    if (node.type === 'map') {
      // The mapped node is a full node definition, minus the ones that park.
      const inner = nodeSchema.safeParse(node.node);
      if (!inner.success)
        issues.push(
          `map node "${id}" has an invalid inner node: ${inner.error.issues
            .map((i) => i.message)
            .join('; ')}`,
        );
      else if (
        ['human', 'wait_event', 'delay', 'map'].includes(inner.data.type)
      )
        issues.push(
          `map node "${id}" cannot map a ${inner.data.type} node; it would park per item`,
        );
    }
  }
  return issues;
}

export function parseDefinition(input: unknown): WorkflowDefinition {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new WorkflowValidationError('invalid workflow definition', issues);
  }
  const issues = checkGraph(parsed.data);
  if (issues.length)
    throw new WorkflowValidationError('invalid workflow graph', issues);
  return parsed.data;
}

// Entry nodes are the ones with no incoming edges; they start together.
export function entryNodes(def: WorkflowDefinition): string[] {
  const hasIncoming = new Set(def.edges.map((e) => e.to));
  return Object.keys(def.nodes).filter((id) => !hasIncoming.has(id));
}

export function topoOrder(def: WorkflowDefinition): string[] {
  const indeg = new Map<string, number>();
  for (const id of Object.keys(def.nodes)) indeg.set(id, 0);
  for (const e of def.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = [...indeg.entries()]
    .filter(([, n]) => n === 0)
    .map(([id]) => id)
    .sort();
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of def.edges) {
      if (e.from !== id) continue;
      const n = (indeg.get(e.to) ?? 1) - 1;
      indeg.set(e.to, n);
      if (n === 0) queue.push(e.to);
    }
  }
  return order;
}
