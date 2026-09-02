import { getWorkflowRow } from '../db.js';
import { evaluate, parseDuration, renderDeep } from '../expr.js';
import { errText, fail, type ExecResult, type Executor } from '../runtime.js';
import { nodeSchema } from '../schema.js';
import { executors } from './index.js';

const DEFAULT_SUBRUN_TIMEOUT = '1d';

// A sub-run is started, then waited on through the ordinary event machinery:
// the parent parks on a `workflow.run.finished` event filtered by the child's
// run id, so a restart resumes it like any other wait.
export const subWorkflowExecutor: Executor = async (ctx) => {
  if (ctx.node.type !== 'workflow') return fail('not a workflow node');
  const node = ctx.node;
  const child = getWorkflowRow(node.slug);
  if (!child) return fail(`unknown workflow: ${node.slug}`);

  try {
    const inputs = node.inputs
      ? (renderDeep(node.inputs, ctx.scope) as Record<string, unknown>)
      : {};
    const floor = ctx.deps.latestEventId();
    // Imported lazily: engine.ts owns run creation and imports the executors.
    const { startRun } = await import('../engine.js');
    const result = await startRun({
      slug: node.slug,
      definition: child.definition,
      inputs,
      triggerType: 'workflow',
      triggerPayload: { parent_run: ctx.run.id, parent_node: ctx.nodeId },
      parentRunId: ctx.run.id,
    });

    if (!result.runId)
      return {
        kind: 'done',
        output: { status: result.status },
        port: 'success',
      };

    // A fast child finishes inside startRun, so check the bus before parking.
    const finished = ctx.deps.findEvent(
      'workflow.run.finished',
      { run_id: result.runId },
      { afterId: floor },
    );
    if (finished) {
      const payload = finished.payload as {
        status?: string;
        error?: string | null;
      };
      if (payload.status !== 'succeeded')
        return fail(
          `sub-run ${result.runId} ${payload.status ?? 'failed'}${
            payload.error ? `: ${payload.error}` : ''
          }`,
        );
      return { kind: 'done', output: finished.payload };
    }

    const timeout = parseDuration(node.timeout ?? DEFAULT_SUBRUN_TIMEOUT);
    return {
      kind: 'wait',
      wait: {
        kind: 'event',
        event_type: 'workflow.run.finished',
        filter: { run_id: result.runId },
        event_floor: floor,
        resume_at: new Date(ctx.deps.now().getTime() + timeout).toISOString(),
        on_timeout: 'fail',
      },
    };
  } catch (err) {
    return fail(errText(err));
  }
};

// One node per item with a concurrency cap. A failed item is kept as an error
// entry rather than dropped, so the array lines up with the input.
export const mapExecutor: Executor = async (ctx) => {
  if (ctx.node.type !== 'map') return fail('not a map node');
  const node = ctx.node;
  const inner = nodeSchema.safeParse(node.node);
  if (!inner.success) return fail('map node has an invalid inner node');

  let items: unknown[];
  try {
    const value = evaluate(node.over, ctx.scope);
    if (!Array.isArray(value))
      return fail(`${node.over} did not yield an array`);
    items = value;
  } catch (err) {
    return fail(errText(err));
  }

  const results: unknown[] = new Array(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index];
      let out: ExecResult;
      try {
        out = await executors[inner.data.type]({
          ...ctx,
          node: inner.data,
          nodeId: `${ctx.nodeId}[${index}]`,
          stepKey: `${ctx.stepKey}:${index}`,
          scope: { ...ctx.scope, item, index },
        });
      } catch (err) {
        out = fail(errText(err));
      }
      results[index] =
        out.kind === 'done'
          ? { ok: true, index, output: out.output }
          : {
              ok: false,
              index,
              error: out.kind === 'fail' ? out.message : 'item parked',
            };
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(node.concurrency, items.length || 1) },
      worker,
    ),
  );

  return { kind: 'done', output: results };
};
