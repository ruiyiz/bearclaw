import { render } from '../expr.js';
import { errText, fail, type Executor } from '../runtime.js';

export const sendExecutor: Executor = async (ctx) => {
  if (ctx.node.type !== 'send') return fail('not a send node');
  const node = ctx.node;
  try {
    const to = node.to ? render(node.to, ctx.scope) : undefined;
    const res = await ctx.deps.send({
      folder: node.agent ?? ctx.def.owner,
      to: to && to !== 'primary' ? to : undefined,
      text: render(node.text, ctx.scope),
      media: node.media?.map((m) => render(m, ctx.scope)),
      stepKey: ctx.stepKey,
    });
    return { kind: 'done', output: { targets: res.targets } };
  } catch (err) {
    return fail(errText(err), true);
  }
};
