import { evaluate, parseDuration, render } from '../expr.js';
import { errText, fail, type Executor } from '../runtime.js';

export const templateExecutor: Executor = async (ctx) => {
  if (ctx.node.type !== 'template') return fail('not a template node');
  try {
    const source =
      ctx.node.template ??
      ctx.deps.readTemplateFile(ctx.node.file!, ctx.def.owner);
    return { kind: 'done', output: render(source, ctx.scope) };
  } catch (err) {
    return fail(errText(err));
  }
};

export const transformExecutor: Executor = async (ctx) => {
  if (ctx.node.type !== 'transform') return fail('not a transform node');
  try {
    return { kind: 'done', output: evaluate(ctx.node.expr, ctx.scope) };
  } catch (err) {
    return fail(errText(err));
  }
};

export const conditionExecutor: Executor = async (ctx) => {
  if (ctx.node.type !== 'condition') return fail('not a condition node');
  try {
    const value = Boolean(evaluate(ctx.node.expr, ctx.scope));
    return { kind: 'done', output: value, port: value ? 'true' : 'false' };
  } catch (err) {
    return fail(errText(err));
  }
};

export const switchExecutor: Executor = async (ctx) => {
  if (ctx.node.type !== 'switch') return fail('not a switch node');
  try {
    const raw = evaluate(ctx.node.expr, ctx.scope);
    const label = raw === null || raw === undefined ? '' : String(raw);
    const port = ctx.node.cases.includes(label) ? label : 'default';
    return { kind: 'done', output: label, port };
  } catch (err) {
    return fail(errText(err));
  }
};

export const emitExecutor: Executor = async (ctx) => {
  if (ctx.node.type !== 'emit') return fail('not an emit node');
  try {
    const type = render(ctx.node.event, ctx.scope);
    const payload = ctx.node.payload
      ? (JSON.parse(render(JSON.stringify(ctx.node.payload), ctx.scope)) as
          | object
          | null)
      : {};
    const id = ctx.deps.emitEvent(type, {
      ...(payload ?? {}),
      run_id: ctx.run.id,
      workflow: ctx.run.slug,
      node: ctx.nodeId,
    });
    return { kind: 'done', output: { event_id: id, type } };
  } catch (err) {
    return fail(errText(err));
  }
};

// A delay is a timer row, never a live setTimeout: the engine wakes it from
// `resume_at` on the next tick or after a restart.
export const delayExecutor: Executor = async (ctx) => {
  if (ctx.node.type !== 'delay') return fail('not a delay node');
  try {
    const now = ctx.deps.now();
    let resumeAt: Date;
    if (ctx.node.duration) {
      resumeAt = new Date(
        now.getTime() + parseDuration(render(ctx.node.duration, ctx.scope)),
      );
    } else {
      const until = render(ctx.node.until!, ctx.scope);
      resumeAt = new Date(until);
      if (Number.isNaN(resumeAt.getTime()))
        return fail(`invalid until: ${until}`);
    }
    if (resumeAt.getTime() <= now.getTime())
      return { kind: 'done', output: { slept_ms: 0 } };
    return {
      kind: 'wait',
      wait: { kind: 'delay', resume_at: resumeAt.toISOString() },
    };
  } catch (err) {
    return fail(errText(err));
  }
};
