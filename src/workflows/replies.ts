import { getRun, getWait, listOpenWaits, type WaitRow } from './db.js';
import { resolveWait } from './engine.js';

const YES = /^(y|yes|ok|okay|sure|approve|approved|do it|go ahead|send it)$/i;
const NO = /^(n|no|nope|reject|rejected|cancel|stop|don'?t)$/i;

// A wait targets a chat when it names it, or when it names nobody and the chat
// belongs to the workflow's owning agent.
export function openWaitsForChat(jid: string, folder: string): WaitRow[] {
  return listOpenWaits('human').filter((w) => {
    if (w.targets?.length) return w.targets.includes(jid);
    const run = getRun(w.run_id);
    return run?.definition.owner === folder;
  });
}

export interface ReplyMatch {
  wait: WaitRow;
  response: unknown;
}

// Only exact answers resolve here. Anything else falls through to the agent,
// which can call workflow_respond with a parsed response.
export function matchReply(waits: WaitRow[], text: string): ReplyMatch | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const byId = waits.find((w) => trimmed.includes(w.id));
  const target = byId ?? waits[0];
  if (!target) return null;

  const body = byId ? trimmed.replace(byId.id, '').trim() : trimmed;

  if (target.options?.length) {
    const option = target.options.find(
      (o) => o.toLowerCase() === body.toLowerCase(),
    );
    return option ? { wait: target, response: { choice: option } } : null;
  }
  if (YES.test(body)) return { wait: target, response: { approved: true } };
  if (NO.test(body)) return { wait: target, response: { approved: false } };
  return null;
}

export async function tryResolveFromMessage(
  jid: string,
  folder: string,
  text: string,
): Promise<WaitRow | null> {
  const waits = openWaitsForChat(jid, folder);
  if (!waits.length) return null;
  const match = matchReply(waits, text);
  if (!match) return null;
  await resolveWait(match.wait.id, match.response, jid, 'channel');
  return match.wait;
}

// Injected into the agent's turn so a free-text reply like "save 1 4,
// summarize 7" can be routed to workflow_respond.
export function describeOpenWaits(jid: string, folder: string): string | null {
  const waits = openWaitsForChat(jid, folder);
  if (!waits.length) return null;
  const lines = waits.map((w) => {
    const run = getRun(w.run_id);
    return [
      `- wait_id ${w.id} · workflow ${run?.slug ?? '?'} · node ${w.node_id}`,
      `  asks: ${w.prompt ?? ''}`,
      w.options?.length ? `  options: ${w.options.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  });
  return [
    '<pending_workflow_questions>',
    'These workflow steps are waiting on the user. If this message answers one,',
    'call workflow_respond with its wait_id and the parsed response, then say so.',
    ...lines,
    '</pending_workflow_questions>',
  ].join('\n');
}

// Callback data is index-based so it stays inside Telegram's 64-byte cap.
export function choiceDataFor(waitId: string, action: string): string {
  return `wf:${waitId}:${action}`;
}

export async function resolveFromCallback(
  jid: string,
  data: string,
): Promise<string | null> {
  const parts = data.split(':');
  if (parts[0] !== 'wf' || parts.length < 3) return null;
  const waitId = parts[1];
  const action = parts.slice(2).join(':');
  const wait = getWait(waitId);
  if (!wait) return 'That question is gone.';
  if (wait.status !== 'open') return 'Already answered.';

  let response: unknown;
  let label: string;
  if (action === 'a') {
    response = { approved: true };
    label = 'Approved';
  } else if (action === 'r') {
    response = { approved: false };
    label = 'Rejected';
  } else {
    const option = wait.options?.[Number(action)];
    if (option === undefined) return 'Unknown option.';
    response = { choice: option };
    label = option;
  }

  await resolveWait(waitId, response, jid, 'telegram');
  return label;
}
