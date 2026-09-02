import { parseDuration, render } from '../expr.js';
import { errText, fail, type Executor } from '../runtime.js';

export function sessionKeyFor(folder: string): string {
  return `agent:${folder}`;
}

function frame(
  ctx: Parameters<Executor>[0],
  prompt: string,
  wantsSchema: boolean,
): string {
  const header = `[WORKFLOW ${ctx.def.name} (${ctx.def.slug}) · node ${ctx.nodeId} · run ${ctx.run.id} · step ${ctx.stepKey}]
This is a workflow step, not a chat turn. Do the work described below and stop.`;
  const schemaNote = wantsSchema
    ? '\nReturn only the structured result required by the output schema.'
    : '';
  return `${header}${schemaNote}\n\n${prompt}`;
}

export const agentExecutor: Executor = async (ctx) => {
  if (ctx.node.type !== 'agent') return fail('not an agent node');
  const node = ctx.node;
  const folder = node.agent ?? ctx.def.owner;
  try {
    const prompt = frame(
      ctx,
      render(node.prompt, ctx.scope),
      node.output_schema !== undefined,
    );

    const sessions = (ctx.run.context.__sessions ?? {}) as Record<
      string,
      string
    >;
    let sessionId: string | undefined;
    if (node.session === 'run') sessionId = sessions[sessionKeyFor(folder)];
    else if (node.session === 'chat')
      sessionId = ctx.deps.getChatSessionId(folder);

    const res = await ctx.deps.runAgent({
      folder,
      chatJid: '',
      prompt,
      model: node.model,
      effort: node.effort,
      sessionId,
      outputSchema: node.output_schema,
      allowedTools: node.allowed_tools,
      maxTurns: node.max_turns,
      timeoutMs: node.timeout ? parseDuration(node.timeout) : undefined,
      stepKey: ctx.stepKey,
      signal: ctx.signal,
    });

    if (res.sessionId && node.session === 'chat')
      ctx.deps.setChatSessionId(folder, res.sessionId);

    if (res.status !== 'success')
      return fail(res.error || 'agent run failed', true);

    // A schema'd node that comes back without structured output is a failure,
    // not a success with prose: downstream nodes index into typed fields.
    if (node.output_schema !== undefined && res.structured === undefined)
      return fail(
        `agent returned no structured output${
          res.text ? `: ${res.text.slice(0, 400)}` : ''
        }`,
        true,
      );

    return {
      kind: 'done',
      output: node.output_schema !== undefined ? res.structured : res.text,
      sessionId: res.sessionId,
    };
  } catch (err) {
    return fail(errText(err), true);
  }
};
