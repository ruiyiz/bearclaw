/**
 * LLM-driven web session title generation. Fires after turn 1, 5, 20 of a web
 * session (see runAgent in src/index.ts). Pulls a slice of the conversation,
 * asks Haiku 4.5 for a 4-6 word title, and writes it via
 * setWebSessionTitleAuto — which silently no-ops if the user has manually
 * renamed the session in the meantime.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

import { getDb, setWebSessionTitleAuto, type StoredMessage } from '../db.js';
import { logger } from '../logger.js';

const MODEL = 'claude-haiku-4-5';
const CONTEXT_BUDGET_BYTES = 4096;
const TAIL_MESSAGES = 4;
const MAX_TITLE_CHARS = 80;

const SYSTEM_PROMPT =
  'Generate a 4-6 word title summarizing the conversation. ' +
  'Output only the title text. No quotes, no punctuation, no markdown, no prefix like "Title:".';

function buildSlice(folder: string, sessionId: string): string | null {
  const jid = `web:${folder}:${sessionId}`;
  const rows = getDb()
    .prepare(
      `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
       FROM messages
       WHERE chat_jid = ?
       ORDER BY timestamp ASC`,
    )
    .all(jid) as StoredMessage[];

  if (rows.length === 0) return null;

  const firstUserIdx = rows.findIndex((r) => r.is_from_me === 0);
  const firstReplyIdx = rows.findIndex(
    (r, i) => i > firstUserIdx && r.is_from_me === 1,
  );

  const anchor: StoredMessage[] = [];
  if (firstUserIdx >= 0) anchor.push(rows[firstUserIdx]);
  if (firstReplyIdx >= 0) anchor.push(rows[firstReplyIdx]);

  const tail = rows.slice(-TAIL_MESSAGES);
  const merged: StoredMessage[] = [];
  const seen = new Set<string>();
  for (const m of [...anchor, ...tail]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push(m);
  }
  merged.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));

  const formatted = merged
    .map((m) => {
      const who = m.is_from_me === 1 ? 'Assistant' : 'User';
      return `${who}: ${m.content}`;
    })
    .join('\n\n');

  return formatted.length <= CONTEXT_BUDGET_BYTES
    ? formatted
    : '[...truncated]\n' + formatted.slice(-CONTEXT_BUDGET_BYTES);
}

function sanitize(raw: string): string | null {
  let t = raw.trim();
  t = t.replace(/^["'`]+|["'`]+$/g, '');
  t = t.replace(/^(title|topic)\s*:\s*/i, '');
  t = t.replace(/[.!?,;:]+$/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length > MAX_TITLE_CHARS) t = t.slice(0, MAX_TITLE_CHARS - 1) + '…';
  return t;
}

export async function generateAndPersistTitle(
  folder: string,
  sessionId: string,
): Promise<void> {
  const slice = buildSlice(folder, sessionId);
  if (!slice) return;

  const userPrompt =
    'Summarize the conversation below as a short title of 4 to 6 words. ' +
    'Return ONLY the title text. No quotes, no punctuation, no markdown, no preamble like "Title:". ' +
    'Do not continue the conversation. Do not answer the user. Do not include any commentary.\n\n' +
    '<conversation>\n' +
    slice +
    '\n</conversation>\n\n' +
    'Title:';

  let raw = '';
  try {
    const q = query({
      prompt: userPrompt,
      options: {
        model: MODEL,
        systemPrompt: SYSTEM_PROMPT,
        allowedTools: [],
        permissionMode: 'bypassPermissions',
        settingSources: [],
      },
    });
    for await (const msg of q) {
      if (msg.type === 'result') {
        const subtype = (msg as { subtype?: string }).subtype;
        if (subtype === 'success' && 'result' in msg) {
          raw = (msg as { result?: string }).result ?? '';
        }
        break;
      }
    }
  } catch (err) {
    logger.warn({ err, folder, sessionId }, 'Title-gen call failed');
    return;
  }

  const title = sanitize(raw);
  if (!title) {
    logger.debug({ folder, sessionId, raw }, 'Title-gen output rejected');
    return;
  }

  setWebSessionTitleAuto(folder, sessionId, title);
  logger.info({ folder, sessionId, title }, 'Title-gen wrote title');
}
