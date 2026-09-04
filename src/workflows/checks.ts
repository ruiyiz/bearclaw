import type { WorkflowDefinition, WorkflowNode } from './schema.js';
import { checkGraph, definitionSchema } from './schema.js';

// Two layers of design-time checking:
//
//   checkGraph (schema.ts)  hard errors — a definition that fails is refused.
//   ADVISORY   (this file)  warnings and hints — saved, but reported back.
//
// `inspect` is the one entry point that runs both.

export type Level = 'error' | 'warn' | 'info';

export interface Issue {
  /** Stable id, so a check can be cited or muted. */
  check: string;
  level: Level;
  node?: string;
  message: string;
  hint?: string;
}

type Check = (def: WorkflowDefinition) => Issue[];

function nodesOf(def: WorkflowDefinition): [string, WorkflowNode][] {
  return Object.entries(def.nodes ?? {});
}

function hasCron(def: WorkflowDefinition): boolean {
  return (def.triggers ?? []).some((t) => t.type === 'cron' && t.enabled);
}

// Every `nodes.<id>` any other node reads.
function referencedNodes(def: WorkflowDefinition): Set<string> {
  const refs = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(/\bnodes\.([A-Za-z_$][\w$]*)/g))
        refs.add(m[1]);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object')
      Object.values(value).forEach(walk);
  };
  walk(def.nodes);
  return refs;
}

// A parked run keeps the workflow "active", and `skip` drops every slot that
// fires while it waits — silently, because on_missed ignores waiting runs.
const blockingSchedule: Check = (def) => {
  if (def.policies.concurrency !== 'skip' || !hasCron(def)) return [];
  return nodesOf(def)
    .filter(([, n]) => n.type === 'human')
    .map(([id]) => ({
      check: 'human/blocking-schedule',
      level: 'warn' as const,
      node: id,
      message:
        'parks the run, and concurrency is "skip", so every scheduled slot is dropped until it is answered',
      hint: 'use "replace" to supersede the old question, or "allow" to let both stand',
    }));
};

// notify:false means the engine sends nothing, so the workflow's own message is
// the only thing the user sees — and it needs to say which question it is.
const unaddressed: Check = (def) =>
  nodesOf(def)
    .filter(
      ([, n]) =>
        n.type === 'human' && n.notify === false && !/wait\.id/.test(n.prompt),
    )
    .map(([id]) => ({
      check: 'human/unaddressed',
      level: 'warn' as const,
      node: id,
      message:
        'sends no notification and its prompt does not name the wait, so a reply cannot say which question it answers',
      hint: 'put {{wait.id}} in the prompt, or drop notify:false',
    }));

const noFailureAlert: Check = (def) => {
  if (!hasCron(def) || def.policies.alerts?.on_failure) return [];
  return [
    {
      check: 'alerts/no-on-failure',
      level: 'warn',
      message: 'runs on a schedule but has no alerts.on_failure',
      hint: 'set policies.alerts.on_failure to "owner" so a 3am failure is not silent',
    },
  ];
};

// Which inputs are declared as a non-string type, and so are safe unquoted.
function numericInputs(def: WorkflowDefinition): Set<string> {
  const safe = new Set<string>();
  for (const [name, spec] of Object.entries(def.inputs?.properties ?? {})) {
    const type = (spec as { type?: unknown }).type;
    if (type === 'integer' || type === 'number' || type === 'boolean')
      safe.add(name);
  }
  return safe;
}

// A hole outside any quote is pasted straight into the command line, so a value
// with a space or a quote in it changes what runs.
const unquotedHole: Check = (def) => {
  const safe = numericInputs(def);
  const issues: Issue[] = [];
  for (const [id, node] of nodesOf(def)) {
    if (node.type !== 'shell') continue;
    let quote: string | null = null;
    const cmd = node.cmd;
    for (let i = 0; i < cmd.length; i++) {
      const c = cmd[i];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        continue;
      }
      if (c !== '{' || cmd[i + 1] !== '{') continue;
      const end = cmd.indexOf('}}', i);
      if (end === -1) break;
      const body = cmd.slice(i + 2, end).trim();
      i = end + 1;
      if (/^q\s/.test(body)) continue;
      const m = /^inputs\.([A-Za-z_$][\w$]*)$/.exec(body);
      if (m && safe.has(m[1])) continue;
      // `join` is how a list becomes several arguments, so it is unquoted on
      // purpose. Worth a note rather than a warning: helpers do not nest, so
      // there is no q-wrapped spelling of it.
      if (/^join\s/.test(body)) {
        issues.push({
          check: 'shell/joined-args',
          level: 'info',
          node: id,
          message: `{{${body}}} expands to several arguments`,
          hint: 'fine for ids and numbers; a value containing a space would split into two arguments',
        });
        continue;
      }
      issues.push({
        check: 'shell/unquoted-hole',
        level: 'warn',
        node: id,
        message: `{{${body}}} is substituted outside any quotes`,
        hint: `write {{q ${body}}} so a space or quote in the value cannot change the command`,
      });
    }
  }
  return issues;
};

// Without a schema an agent node returns prose, and a node downstream that
// indexes into it gets undefined at 3am rather than a failure here.
const unstructuredAgent: Check = (def) => {
  const read = referencedNodes(def);
  return nodesOf(def)
    .filter(
      ([id, n]) =>
        n.type === 'agent' && n.output_schema === undefined && read.has(id),
    )
    .map(([id]) => ({
      check: 'agent/no-output-schema',
      level: 'warn' as const,
      node: id,
      message: 'is read by another node but returns free text',
      hint: 'give it an output_schema so the run fails here rather than downstream',
    }));
};

// map returns {ok, output|error} per item and never fails, so a consumer that
// ignores `ok` treats a half-finished fan-out as a success.
const uncheckedMap: Check = (def) => {
  const mapped = nodesOf(def)
    .filter(([, n]) => n.type === 'map')
    .map(([id]) => id);
  if (!mapped.length) return [];
  const source = JSON.stringify(def.nodes);
  return mapped
    .filter(
      (id) =>
        !new RegExp(`nodes\\.${id}[^\\w$]*[\\s\\S]{0,200}?\\.ok`).test(source),
    )
    .map((id) => ({
      check: 'map/unchecked',
      level: 'info' as const,
      node: id,
      message: 'fans out but nothing downstream looks at each item’s `ok`',
      hint: 'a failed item is reported, not thrown — check it or a partial result passes as success',
    }));
};

export const ADVISORY: Check[] = [
  blockingSchedule,
  unaddressed,
  noFailureAlert,
  unquotedHole,
  unstructuredAgent,
  uncheckedMap,
];

/** Warnings and hints only. A definition with these still saves. */
export function advise(def: WorkflowDefinition): Issue[] {
  return ADVISORY.flatMap((check) => check(def));
}

/**
 * Everything, on a definition that has not been through the loader: shape
 * errors, then graph errors, then advice. Reports rather than throws, so a
 * draft can be checked before anyone tries to save it.
 */
export function inspect(input: unknown): Issue[] {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success)
    return parsed.error.issues.map((i) => ({
      check: 'schema',
      level: 'error' as const,
      message: `${i.path.join('.') || '(root)'}: ${i.message}`,
    }));

  const def = parsed.data;
  const errors: Issue[] = checkGraph(def).map((message) => ({
    check: 'graph',
    level: 'error' as const,
    message,
  }));
  return [...errors, ...advise(def)];
}

export function formatIssue(issue: Issue): string {
  const where = issue.node ? `${issue.node}: ` : '';
  const hint = issue.hint ? ` — ${issue.hint}` : '';
  return `[${issue.level}] ${where}${issue.message}${hint}`;
}
