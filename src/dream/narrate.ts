/**
 * Dream Cycle — Narrate phase.
 *
 * Subagent run with read-only filesystem access (Read/Glob) for the agent's
 * own folder, and Write only for the dreams/ directory. Produces a single
 * 80–180 word reflective entry summarizing what was promoted and why.
 */

import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { runDreamSubagent } from './subagent.js';
import { PromotedEngram } from './types.js';

const SYSTEM_PROMPT = `You are the Narrate phase of a memory-consolidation pipeline. You write a brief diary entry, not a formal report.

Voice: a curious, reflective mind taking stock of what was learned today. First-person, lowercase headers if any. Avoid bullet lists and meta-commentary.

Length: 80–180 words. One paragraph or two short paragraphs. No headings, no preamble, no signoff.

You are given a list of newly-promoted memory traces ("engrams") with theme tags and the day's date. Write a short reflective entry that:
  - Names the day (e.g., "Tuesday, May 5") in the opening line.
  - Surfaces the strongest themes that emerged.
  - Notes one or two specific facts or decisions worth remembering.
  - Acknowledges if the day was thin (few engrams) without padding.

You have a single Write tool available. Use it to create the file at the absolute path provided in the user prompt. Do not use any other tools. Do not produce text output beyond what the Write tool writes.`;

function buildPrompt(promoted: PromotedEngram[], outputPath: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const items = promoted.slice(0, 30).map((p) => ({
    snippet: p.snippet.length > 220 ? p.snippet.slice(0, 220) + '…' : p.snippet,
    themes: p.theme_tags,
    score: Number(p.score.toFixed(2)),
  }));
  return [
    `Date: ${today}`,
    `Engram count: ${promoted.length}`,
    '',
    'Write the diary entry to this exact absolute path:',
    `  ${outputPath}`,
    '',
    'Promoted engrams:',
    JSON.stringify({ engrams: items }, null, 2),
  ].join('\n');
}

export async function runNarratePhase(
  agentFolder: string,
  varDir: string,
  promoted: PromotedEngram[],
): Promise<string | null> {
  const dreamsDir = path.join(varDir, 'dreams');
  fs.mkdirSync(dreamsDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const outputPath = path.join(dreamsDir, `${today}.md`);

  if (promoted.length === 0) {
    // No promotions; write a brief stub so the diary has continuity.
    const stub = `${today}\n\nA quiet day. No new engrams promoted; nothing crossed the threshold.\n`;
    fs.writeFileSync(outputPath, stub);
    return outputPath;
  }

  const out = await runDreamSubagent({
    prompt: buildPrompt(promoted, outputPath),
    cwd: varDir,
    systemPrompt: SYSTEM_PROMPT,
    allowedTools: ['Write'],
    timeoutMs: 4 * 60 * 1000,
  });

  if (out.status !== 'success') {
    logger.warn(
      { agentFolder, error: out.error },
      'Narrate phase: subagent failed',
    );
    return null;
  }

  if (!fs.existsSync(outputPath)) {
    logger.warn(
      { agentFolder, outputPath },
      'Narrate phase: subagent did not write file',
    );
    return null;
  }

  logger.info(
    { agentFolder, outputPath, engramCount: promoted.length },
    'Dream Narrate phase complete',
  );
  return outputPath;
}
