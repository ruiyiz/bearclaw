import { parseDuration, render, renderDeep } from '../expr.js';
import { errText, fail, type Executor } from '../runtime.js';
import { parseStdout } from './shell.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export const httpExecutor: Executor = async (ctx) => {
  if (ctx.node.type !== 'http') return fail('not an http node');
  const node = ctx.node;
  const timeoutMs = node.timeout
    ? parseDuration(node.timeout)
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = render(node.url, ctx.scope);
    const headers: Record<string, string> = {
      'x-bearclaw-step-key': ctx.stepKey,
      ...renderDeep(node.headers ?? {}, ctx.scope),
    };
    let body: string | undefined;
    if (node.body !== undefined) {
      if (typeof node.body === 'string') body = render(node.body, ctx.scope);
      else {
        body = JSON.stringify(renderDeep(node.body, ctx.scope));
        headers['content-type'] ??= 'application/json';
      }
    }
    const res = await ctx.deps.fetch(url, {
      method: node.method.toUpperCase(),
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 429;
      return fail(`HTTP ${res.status}: ${text.slice(0, 500)}`, retryable);
    }
    return {
      kind: 'done',
      output: {
        status: res.status,
        body: parseStdout(text, node.parse),
      },
    };
  } catch (err) {
    return fail(errText(err), true);
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
  }
};
