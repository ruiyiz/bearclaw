/**
 * Dream Cycle — Deep phase (deterministic).
 *
 * Scores every candidate over 6 weighted signals, applies 3 gates, rehydrates
 * each survivor against its source files, then promotes winners into the
 * agent's ENGRAM.md. Pure code; no LLM.
 */

import fs from 'fs';
import path from 'path';

import {
  DREAM_ENGRAM_LINE_CAP,
  DREAM_MIN_DIVERSITY,
  DREAM_MIN_SCORE,
  DREAM_MIN_SUPPORT,
  DREAM_RECENCY_HALFLIFE,
} from '../config.js';
import {
  DreamCandidate,
  getDreamCandidatesForAgent,
  markDreamCandidatePromoted,
  setDreamCandidateScore,
} from '../db.js';
import { logger } from '../logger.js';
import { PromotedEngram } from './types.js';

const WEIGHTS = {
  frequency: 0.24,
  relevance: 0.3,
  query_diversity: 0.15,
  recency: 0.15,
  consolidation: 0.1,
  richness: 0.06,
} as const;

interface ScoredCandidate {
  c: DreamCandidate;
  score: number;
  diversity: number;
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  const union = a.size + b.size - intersect;
  return union ? intersect / union : 0;
}

function rehydrate(candidate: DreamCandidate, agentDir: string): boolean {
  let paths: string[];
  try {
    paths = JSON.parse(candidate.source_paths);
  } catch {
    return false;
  }
  const snippetTokens = tokenize(candidate.snippet);
  if (snippetTokens.size === 0) return false;

  for (const p of paths) {
    try {
      const full = path.join(agentDir, p);
      if (!fs.existsSync(full)) continue;
      const content = fs.readFileSync(full, 'utf-8');
      const fileTokens = tokenize(content);
      let hits = 0;
      for (const t of snippetTokens) if (fileTokens.has(t)) hits++;
      if (hits / snippetTokens.size >= 0.6) return true;
    } catch {
      /* continue */
    }
  }
  return false;
}

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

function rewriteRelativeDates(
  snippet: string,
  runDate: Date = new Date(),
): string {
  const today = runDate.toISOString().slice(0, 10);
  const yesterday = new Date(runDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const tomorrow = new Date(runDate);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const replacements: Array<[RegExp, string]> = [
    [/\btoday\b/gi, today],
    [/\byesterday\b/gi, yesterday.toISOString().slice(0, 10)],
    [/\btomorrow\b/gi, tomorrow.toISOString().slice(0, 10)],
    [/\bthis week\b/gi, `week of ${today}`],
    [/\blast week\b/gi, `week before ${today}`],
  ];

  let result = snippet;
  for (const [re, sub] of replacements) result = result.replace(re, sub);

  // Day-of-week names: convert "next Tuesday" / "on Tuesday" to next occurrence
  for (let i = 0; i < WEEKDAYS.length; i++) {
    const name = WEEKDAYS[i];
    const re = new RegExp(`\\b(?:next |on |this )?${name}\\b`, 'gi');
    result = result.replace(re, () => {
      const target = new Date(runDate);
      const delta = (i - target.getDay() + 7) % 7 || 7;
      target.setDate(target.getDate() + delta);
      return target.toISOString().slice(0, 10);
    });
  }

  return result;
}

function score(
  c: DreamCandidate,
  runMaxSupport: number,
  todayUnix: number,
): { score: number; diversity: number } {
  const frequency =
    Math.log1p(c.support_count) / Math.log1p(Math.max(runMaxSupport, 1));

  // Without retrieval logs yet, use a neutral relevance baseline. When the
  // dream's retrieval feedback is wired in (planned), this will use the
  // actual mean retrieval score instead.
  const relevance =
    c.retrieval_hits > 0
      ? Math.max(
          0,
          Math.min(1, c.retrieval_score / Math.max(c.retrieval_hits, 1)),
        )
      : 0.5;

  let queryChats: unknown[] = [];
  try {
    queryChats = JSON.parse(c.query_chats);
  } catch {
    /* empty */
  }
  const queryDiversityRaw = Math.max(queryChats.length, c.distinct_days);
  const queryDiversity = Math.min(queryDiversityRaw / 5, 1);

  const daysSinceLastSeen = Math.max(0, (todayUnix - c.last_seen) / 86400);
  const recency = Math.exp(
    -daysSinceLastSeen / Math.max(DREAM_RECENCY_HALFLIFE, 1),
  );

  const consolidation = Math.min(c.distinct_days / 7, 1);

  let themeTags: unknown[] = [];
  try {
    themeTags = JSON.parse(c.theme_tags);
  } catch {
    /* empty */
  }
  const richness = Math.min(themeTags.length, 5) / 5;

  const total =
    WEIGHTS.frequency * frequency +
    WEIGHTS.relevance * relevance +
    WEIGHTS.query_diversity * queryDiversity +
    WEIGHTS.recency * recency +
    WEIGHTS.consolidation * consolidation +
    WEIGHTS.richness * richness;

  return {
    score: Math.max(0, Math.min(1, total)),
    diversity: queryDiversityRaw,
  };
}

interface EngramLine {
  text: string;
  score: number;
}

function parseEngram(content: string): EngramLine[] {
  const lines: EngramLine[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim().startsWith('- ')) continue;
    const m = line.match(/<!-- meta: (\{[^}]*\}) -->/);
    let s = 0;
    if (m) {
      try {
        s = (JSON.parse(m[1]) as { score?: number }).score ?? 0;
      } catch {
        /* leave 0 */
      }
    }
    lines.push({ text: line, score: s });
  }
  return lines;
}

function formatEngramLine(promoted: PromotedEngram, runDate: string): string {
  const oneLine = promoted.snippet.replace(/\s+/g, ' ').trim();
  const meta = JSON.stringify({
    score: Number(promoted.score.toFixed(3)),
    themes: promoted.theme_tags,
    promoted_at: runDate,
    candidate_id: promoted.candidate_id,
  });
  return `- ${oneLine} <!-- meta: ${meta} -->`;
}

/**
 * Append promoted lines to ENGRAM.md and enforce the line cap by demoting
 * lowest-scored entries. The file is kept human-readable; metadata is in
 * trailing HTML comments.
 */
export function appendToEngram(
  agentDir: string,
  promoted: PromotedEngram[],
): void {
  if (promoted.length === 0) return;
  const engramPath = path.join(agentDir, 'ENGRAM.md');
  const existing = fs.existsSync(engramPath)
    ? fs.readFileSync(engramPath, 'utf-8')
    : '';
  const existingLines = parseEngram(existing);
  const runDate = new Date().toISOString().slice(0, 10);
  const newLines = promoted.map((p) => ({
    text: formatEngramLine(p, runDate),
    score: p.score,
  }));

  const all = [...existingLines, ...newLines];
  // Sort by score descending; cap to DREAM_ENGRAM_LINE_CAP
  all.sort((a, b) => b.score - a.score);
  const kept = all.slice(0, DREAM_ENGRAM_LINE_CAP);
  // Re-sort kept lines by score descending (so highest-value at top)
  const header =
    '# Engram\n\n_Curated long-term memory traces, written by the dream cycle. Highest-scored entries first._\n\n';
  fs.writeFileSync(
    engramPath,
    header + kept.map((l) => l.text).join('\n') + '\n',
  );
}

/**
 * Run the Deep phase for one agent. Returns the list of promoted entries.
 */
export function runDeepPhase(
  agentFolder: string,
  agentDir: string,
): PromotedEngram[] {
  const all = getDreamCandidatesForAgent(agentFolder);
  if (all.length === 0) return [];

  const runMaxSupport = Math.max(...all.map((c) => c.support_count), 1);
  const todayUnix = Math.floor(Date.now() / 1000);

  const scored: ScoredCandidate[] = all.map((c) => {
    const { score: s, diversity } = score(c, runMaxSupport, todayUnix);
    setDreamCandidateScore(c.id, s);
    return { c, score: s, diversity };
  });

  // Apply gates
  const survivors = scored.filter(
    ({ c, score, diversity }) =>
      score >= DREAM_MIN_SCORE &&
      c.support_count >= DREAM_MIN_SUPPORT &&
      diversity >= DREAM_MIN_DIVERSITY,
  );

  // Rehydrate
  const rehydrated = survivors.filter(({ c }) => rehydrate(c, agentDir));

  if (rehydrated.length < survivors.length) {
    logger.info(
      { agentFolder, dropped: survivors.length - rehydrated.length },
      'Deep phase: dropped candidates after rehydration',
    );
  }

  // Build PromotedEngram entries with absolute-date rewriting
  const now = Math.floor(Date.now() / 1000);
  const promoted: PromotedEngram[] = rehydrated.map(({ c, score: s }) => {
    let themes: string[] = [];
    try {
      themes = JSON.parse(c.theme_tags);
    } catch {
      /* empty */
    }
    return {
      candidate_id: c.id,
      agent_folder: agentFolder,
      snippet: rewriteRelativeDates(c.snippet),
      score: s,
      theme_tags: themes,
    };
  });

  // Write to ENGRAM.md
  appendToEngram(agentDir, promoted);

  for (const p of promoted) {
    markDreamCandidatePromoted(p.candidate_id, 'ENGRAM', now);
  }

  logger.info(
    {
      agentFolder,
      scored: scored.length,
      gated: survivors.length,
      promoted: promoted.length,
    },
    'Dream Deep phase complete',
  );
  return promoted;
}
