import vm from 'node:vm';

export interface EvalScope {
  run: { id: string; slug: string; started_at: string; key: string };
  trigger: { id: string | null; type: string | null; payload: unknown };
  inputs: Record<string, unknown>;
  nodes: Record<string, { output: unknown; status: string }>;
  env: Record<string, string | undefined>;
  error?: { node: string; message: string } | null;
  item?: unknown;
  index?: number;
}

export class ExpressionError extends Error {
  constructor(
    readonly expr: string,
    cause: unknown,
  ) {
    super(
      `expression failed: ${expr} — ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'ExpressionError';
  }
}

const EXPR_TIMEOUT_MS = 50;
const scriptCache = new Map<string, vm.Script>();

// `a.b.*.c` is sugar for plucking a field off every element of an array.
// Rewritten before compilation so the sandbox only ever sees plain JS.
export function expandWildcards(src: string): string {
  let out = src;
  for (let i = 0; i < 8; i++) {
    const next = out.replace(
      /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])*)\.\*\.([A-Za-z_$][\w$]*)/g,
      '($1).map((__w) => __w.$2)',
    );
    if (next === out) break;
    out = next;
  }
  return out;
}

function compile(expr: string): vm.Script {
  const cached = scriptCache.get(expr);
  if (cached) return cached;
  const script = new vm.Script(`(${expandWildcards(expr)})`, {
    filename: 'workflow-expression.js',
  });
  scriptCache.set(expr, script);
  return script;
}

// The sandbox exists for determinism and accident containment, not as a
// security boundary: the only authors are the owner and an agent that already
// has shell access.
function contextFor(scope: EvalScope): vm.Context {
  const sandbox: Record<string, unknown> = {
    run: scope.run,
    trigger: scope.trigger,
    inputs: scope.inputs,
    nodes: scope.nodes,
    env: scope.env,
    error: scope.error ?? null,
    item: scope.item,
    index: scope.index,
  };
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });
  vm.runInContext(
    `delete this.Date;
     Math.random = function () { throw new Error('Math.random is unavailable in workflow expressions; use run.started_at'); };`,
    context,
  );
  return context;
}

export function evaluate(expr: string, scope: EvalScope): unknown {
  try {
    return compile(expr).runInContext(contextFor(scope), {
      timeout: EXPR_TIMEOUT_MS,
    });
  } catch (err) {
    throw new ExpressionError(expr, err);
  }
}

export function shellQuote(value: unknown): string {
  const s = stringify(value);
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return JSON.stringify(value);
}

// Splits `json nodes.a.output` / `join x ' '` into tokens, keeping quoted
// literals intact.
function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      cur += c;
      if (c === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === `'` || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) tokens.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

const HELPERS = new Set(['json', 'q', 'join', 'default']);

function argValue(token: string, scope: EvalScope): unknown {
  const first = token[0];
  if ((first === `'` || first === '"') && token.endsWith(first))
    return token.slice(1, -1).replace(/\\(['"])/g, '$1');
  return evaluate(token, scope);
}

export function renderExpression(source: string, scope: EvalScope): string {
  const trimmed = source.trim();
  const tokens = tokenize(trimmed);
  const head = tokens[0];
  if (tokens.length > 1 && HELPERS.has(head)) {
    const args = tokens.slice(1).map((t) => argValue(t, scope));
    switch (head) {
      case 'json':
        return JSON.stringify(args[0] ?? null);
      case 'q':
        return shellQuote(args[0]);
      case 'join': {
        const list = Array.isArray(args[0]) ? args[0] : [args[0]];
        const sep = args.length > 1 ? stringify(args[1]) : ' ';
        return list.map(stringify).join(sep);
      }
      case 'default':
        return stringify(
          args[0] === undefined || args[0] === null || args[0] === ''
            ? args[1]
            : args[0],
        );
    }
  }
  return stringify(evaluate(trimmed, scope));
}

export function render(template: string, scope: EvalScope): string {
  return template.replace(/\{\{([\s\S]*?)\}\}/g, (_m, body: string) =>
    renderExpression(body, scope),
  );
}

export function renderDeep<T>(value: T, scope: EvalScope): T {
  if (typeof value === 'string') return render(value, scope) as unknown as T;
  if (Array.isArray(value))
    return value.map((v) => renderDeep(v, scope)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value))
      out[render(k, scope)] = renderDeep(v, scope);
    return out as unknown as T;
  }
  return value;
}

const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i;
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function parseDuration(input: string): number {
  const m = DURATION.exec(input.trim());
  if (!m) throw new Error(`invalid duration: ${input}`);
  return Math.round(parseFloat(m[1]) * UNIT_MS[m[2].toLowerCase()]);
}
