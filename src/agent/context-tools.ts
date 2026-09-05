import {
  getContextFile,
  listContextFiles,
  writeContextFile,
  type ContextScope,
} from '../store/context.js';

// Handlers for the mcp__bearclaw__context_* tools, kept free of the SDK so the
// authorization rules can be exercised directly.

export const MAX_CONTEXT_BYTES = 256 * 1024;

export interface ContextToolCtx {
  agentFolder: string;
  isMain: boolean;
}

export interface ContextReadArgs {
  scope: ContextScope;
  name: string;
  folder?: string;
}

export interface ContextWriteArgs extends ContextReadArgs {
  content: string;
  mode?: 'replace' | 'append';
}

const EFFECTIVE_NEXT_TURN =
  'The copy injected into this session was built when the session started, so the change takes effect on your next turn.';

// Which folder a call is allowed to touch. Only the main agent reaches other
// folders; everyone else is pinned to their own.
function resolveFolder(
  ctx: ContextToolCtx,
  requested: string | undefined,
  verb: 'read' | 'write',
): string {
  const folder = requested?.trim() || ctx.agentFolder;
  if (folder !== ctx.agentFolder && !ctx.isMain) {
    throw new Error(
      `not allowed to ${verb} another agent's context (${folder})`,
    );
  }
  return folder;
}

export function contextList(ctx: ContextToolCtx): string {
  const listing = listContextFiles();
  const lines: string[] = ['shared:'];
  if (listing.shared.length === 0) lines.push('  (none)');
  for (const f of listing.shared) {
    lines.push(`  ${f.name} (${f.size} bytes, updated ${f.modifiedAt})`);
  }
  const agents = ctx.isMain
    ? listing.agents
    : listing.agents.filter((a) => a.folder === ctx.agentFolder);
  for (const agent of agents) {
    lines.push(`agent ${agent.folder}:`);
    if (agent.files.length === 0) lines.push('  (none)');
    for (const f of agent.files) {
      lines.push(`  ${f.name} (${f.size} bytes, updated ${f.modifiedAt})`);
    }
  }
  return lines.join('\n');
}

export function contextRead(
  ctx: ContextToolCtx,
  args: ContextReadArgs,
): string {
  if (args.scope === 'shared') {
    const content = getContextFile('shared', '', args.name);
    if (content === undefined) throw new Error(`no such file: ${args.name}`);
    return content;
  }
  const folder = resolveFolder(ctx, args.folder, 'read');
  const content = getContextFile('agent', folder, args.name);
  if (content === undefined) {
    throw new Error(`no such file: ${folder}/${args.name}`);
  }
  return content;
}

export function contextWrite(
  ctx: ContextToolCtx,
  args: ContextWriteArgs,
): string {
  const mode = args.mode ?? 'append';
  if (args.scope === 'shared' && !ctx.isMain) {
    throw new Error('only the main agent may write shared context');
  }
  const folder =
    args.scope === 'shared' ? '' : resolveFolder(ctx, args.folder, 'write');

  const existing = getContextFile(args.scope, folder, args.name) ?? '';
  let next: string;
  if (mode === 'append') {
    const separator = !existing || existing.endsWith('\n') ? '' : '\n';
    next = `${existing}${separator}${args.content}`;
  } else {
    next = args.content;
  }
  if (Buffer.byteLength(next, 'utf-8') > MAX_CONTEXT_BYTES) {
    throw new Error(
      `context file would exceed ${MAX_CONTEXT_BYTES} bytes — trim it first`,
    );
  }

  const { modifiedAt } = writeContextFile(
    args.scope,
    args.scope === 'shared' ? null : folder,
    args.name,
    next,
  );
  const label = args.scope === 'shared' ? args.name : `${folder}/${args.name}`;
  const verb = mode === 'append' ? 'Appended to' : 'Rewrote';
  return `${verb} ${label} (${Buffer.byteLength(next, 'utf-8')} bytes, ${modifiedAt}). ${EFFECTIVE_NEXT_TURN}`;
}
