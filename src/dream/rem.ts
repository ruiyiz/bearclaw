/**
 * Dream Cycle — REM phase.
 *
 * Subagent run with NO tools. Candidate set is passed via prompt. The
 * subagent groups candidates into themes, flags contradictions and
 * reinforcements, and returns a single JSON document. The runner parses
 * and writes back to dream_candidates. No filesystem traversal, no
 * memory_search, no Read.
 */

import {
  DreamCandidate,
  getDreamCandidatesForAgent,
  setDreamCandidateThemes,
} from '../db.js';
import { logger } from '../logger.js';
import { runDreamSubagent } from './subagent.js';

const SYSTEM_PROMPT = `You are the REM phase of a memory-consolidation pipeline.

You receive a JSON list of candidate memory snippets the agent has accumulated over the past week. Each snippet is raw/messy text from logs and conversations. Your job for each candidate:
  1. Distill a single-sentence "summary" capturing the durable fact, preference, decision, or observation worth remembering long-term. Maximum 200 characters. Third-person voice. Do NOT include timestamps, quotes, transcript framing, or narration of mechanics. If nothing in the snippet is worth keeping, set summary to null.
  2. Assign theme tags (concise, kebab-case, prefixed: "user:", "task:", "decision:", "fact:", "preference:", "person:", "project:", or "topic:"). Examples: "user:health", "decision:budget-cap", "fact:address", "person:alice".
  3. Flag contradicts_id if the snippet directly conflicts with another candidate (use the other candidate's id).
  4. Flag reinforces_id if the snippet strongly restates another candidate (use the other candidate's id).

Output ONLY a single JSON object, no prose, no markdown fences:

{"items":[{"id":1,"summary":"User prefers strength training over cardio.","themes":["user:health","preference:training"],"contradicts_id":null,"reinforces_id":null}]}

Rules:
  - Every candidate id must appear exactly once in items.
  - summary: ≤200 chars, single sentence, or null if not worth keeping.
  - themes: 1–5 tags per candidate.
  - contradicts_id and reinforces_id may both be null.
  - Do NOT invent ids. Only reference ids present in the input.
  - Do NOT emit any text outside the JSON object.`;

interface RemOutput {
  items: Array<{
    id: number;
    summary: string | null;
    themes: string[];
    contradicts_id: number | null;
    reinforces_id: number | null;
  }>;
}

function buildPrompt(candidates: DreamCandidate[]): string {
  const items = candidates.map((c) => ({
    id: c.id,
    snippet: c.snippet.slice(0, 800),
  }));
  return [
    'Today is ' + new Date().toISOString().slice(0, 10) + '.',
    '',
    'Candidates:',
    JSON.stringify({ candidates: items }, null, 2),
    '',
    'Return JSON now.',
  ].join('\n');
}

function tryParseRemOutput(raw: string): RemOutput | null {
  // Strip code fences if any
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && Array.isArray(parsed.items)) return parsed as RemOutput;
  } catch {
    /* fall through */
  }
  // Try to find the first {...} block
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && Array.isArray(parsed.items)) return parsed as RemOutput;
    } catch {
      /* nothing */
    }
  }
  return null;
}

/**
 * Run the REM phase for one agent. Returns the number of candidates tagged.
 */
export async function runRemPhase(
  agentFolder: string,
  agentDir: string,
): Promise<number> {
  const candidates = getDreamCandidatesForAgent(agentFolder);
  if (candidates.length === 0) return 0;

  const validIds = new Set(candidates.map((c) => c.id));
  const prompt = buildPrompt(candidates);
  const out = await runDreamSubagent({
    prompt,
    cwd: agentDir,
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: [],
    timeoutMs: 4 * 60 * 1000,
  });

  if (out.status !== 'success' || !out.result) {
    logger.warn(
      { agentFolder, error: out.error },
      'REM phase: subagent failed',
    );
    return 0;
  }

  const parsed = tryParseRemOutput(out.result);
  if (!parsed) {
    logger.warn(
      { agentFolder, sample: out.result.slice(0, 200) },
      'REM phase: could not parse output',
    );
    return 0;
  }

  let tagged = 0;
  for (const item of parsed.items) {
    if (!validIds.has(item.id)) continue;
    const themes = (item.themes || [])
      .slice(0, 5)
      .filter((t) => typeof t === 'string');
    const contradicts =
      item.contradicts_id !== null && validIds.has(item.contradicts_id)
        ? item.contradicts_id
        : null;
    const reinforces =
      item.reinforces_id !== null && validIds.has(item.reinforces_id)
        ? item.reinforces_id
        : null;
    const summary =
      typeof item.summary === 'string' && item.summary.trim()
        ? item.summary.trim().slice(0, 200)
        : null;
    setDreamCandidateThemes(item.id, themes, contradicts, reinforces, summary);
    tagged++;
  }

  logger.info(
    { agentFolder, tagged, total: candidates.length },
    'Dream REM phase complete',
  );
  return tagged;
}
