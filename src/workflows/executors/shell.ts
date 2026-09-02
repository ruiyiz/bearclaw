import { parseDuration, render } from '../expr.js';
import { errText, fail, type Executor } from '../runtime.js';

const DEFAULT_TIMEOUT_MS = 120_000;

export function parseStdout(raw: string, mode: 'json' | 'text' | 'lines') {
  const text = raw.trim();
  if (mode === 'json') {
    if (!text) return null;
    return JSON.parse(text);
  }
  if (mode === 'lines')
    return text ? text.split('\n').map((l) => l.trimEnd()) : [];
  return text;
}

export const shellExecutor: Executor = async (ctx) => {
  if (ctx.node.type !== 'shell') return fail('not a shell node');
  const node = ctx.node;
  try {
    const cmd = render(node.cmd, ctx.scope);
    const env: Record<string, string> = { BEARCLAW_STEP_KEY: ctx.stepKey };
    for (const [k, v] of Object.entries(node.env ?? {}))
      env[k] = render(v, ctx.scope);
    const res = await ctx.deps.runShell({
      cmd,
      cwd: node.cwd ? render(node.cwd, ctx.scope) : undefined,
      env,
      stdin: node.stdin ? render(node.stdin, ctx.scope) : undefined,
      timeoutMs: node.timeout
        ? parseDuration(node.timeout)
        : DEFAULT_TIMEOUT_MS,
      signal: ctx.signal,
    });
    if (res.timedOut) return fail(`command timed out: ${cmd}`, true);
    if (res.code !== 0)
      return fail(
        `exit ${res.code}: ${(res.stderr || res.stdout).trim().slice(0, 500)}`,
        true,
      );
    return { kind: 'done', output: parseStdout(res.stdout, node.parse) };
  } catch (err) {
    return fail(errText(err));
  }
};
