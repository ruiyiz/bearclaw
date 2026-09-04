import { newId } from '../db.js';
import { parseDuration, render, renderDeep } from '../expr.js';
import { errText, fail, type Executor } from '../runtime.js';

export const humanExecutor: Executor = async (ctx) => {
  if (ctx.node.type !== 'human') return fail('not a human node');
  const node = ctx.node;
  try {
    const resumeAt = new Date(
      ctx.deps.now().getTime() + parseDuration(node.expires),
    ).toISOString();
    // The id is minted here rather than at insert time so `{{wait.id}}` can go
    // into the prompt. A workflow that writes its own message (notify: false)
    // can then carry its own return address: one run may have several
    // questions open at once, so the run id alone would not say which.
    const id = newId('wait');
    const scope = { ...ctx.scope, wait: { id } };
    return {
      kind: 'wait',
      wait: {
        id,
        kind: 'human',
        prompt: render(node.prompt, scope),
        options: node.options?.map((o) => render(o, scope)) ?? null,
        targets: node.to?.map((t) => render(t, scope)) ?? null,
        fields: node.fields ?? null,
        resume_at: resumeAt,
        on_timeout: node.on_timeout ?? null,
      },
    };
  } catch (err) {
    return fail(errText(err));
  }
};

// Matches against events already persisted since the run started, so a signal
// that lands before this node is reached is not lost.
export const waitEventExecutor: Executor = async (ctx) => {
  if (ctx.node.type !== 'wait_event') return fail('not a wait_event node');
  const node = ctx.node;
  if (!node.timeout) return fail('wait_event requires a timeout');
  try {
    const type = render(node.event, ctx.scope);
    const filter = node.filter
      ? (renderDeep(node.filter, ctx.scope) as Record<string, unknown>)
      : null;
    // Without a lookback the floor is the event id at run start, so a signal
    // that landed earlier in this run still matches. A lookback widens the
    // window to wall-clock time instead.
    const floor = Number(ctx.run.context.__event_floor ?? 0);
    const window = node.lookback
      ? {
          sinceIso: new Date(
            ctx.deps.now().getTime() - parseDuration(node.lookback),
          ).toISOString(),
        }
      : { afterId: floor };

    const existing = ctx.deps.findEvent(type, filter, window);
    if (existing)
      return { kind: 'done', output: existing.payload, port: 'received' };

    const resumeAt = new Date(
      ctx.deps.now().getTime() + parseDuration(node.timeout),
    ).toISOString();
    return {
      kind: 'wait',
      wait: {
        kind: 'event',
        event_type: type,
        filter,
        event_floor: floor,
        resume_at: resumeAt,
        on_timeout: 'timeout',
      },
    };
  } catch (err) {
    return fail(errText(err));
  }
};
