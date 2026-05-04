/**
 * Dream Cycle — Shared promotion phase (main agent only).
 *
 * Reads every registered agent's ENGRAM.md, aggregates near-duplicate lines
 * across agents, scores using `distinct agents` as the diversity signal,
 * applies the same gates, rehydrates against each source ENGRAM.md, and
 * promotes winners into context/MEMORY.md (200-line cap).
 *
 * Pure code; no LLM. Replaces the previous event-based proposal mechanism.
 */

import fs from 'fs';
import path from 'path';

import {
  AGENTS_DIR,
  CONTEXT_DIR,
  DREAM_ENGRAM_LINE_CAP,
  DREAM_MIN_DIVERSITY,
  DREAM_MIN_SCORE,
  DREAM_MIN_SUPPORT,
  DREAM_RECENCY_HALFLIFE,
} from '../config.js';
import { logger } from '../logger.js';

interface EngramEntry {
  agentFolder: string;
  text: string;
  rawLine: string;
  score: number;
  themes: string[];
  promotedAt: string | null;
}

interface SharedCandidate {
  textNormalized: string;
  representativeText: string;
  agents: Set<string>;
  themes: Set<string>;
  scoresByAgent: number[];
  latestPromotedAt: string | null;
  rawLines: Array<{ agent: string; line: string }>;
}

const META_RE = /<!-- meta: (\{[^}]*\}) -->/;

function parseEngramFile(content: string, agentFolder: string): EngramEntry[] {
  const out: EngramEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) continue;
    const m = trimmed.match(META_RE);
    let score = 0;
    let themes: string[] = [];
    let promotedAt: string | null = null;
    if (m) {
      try {
        const meta = JSON.parse(m[1]) as {
          score?: number;
          themes?: string[];
          promoted_at?: string;
        };
        if (typeof meta.score === 'number') score = meta.score;
        if (Array.isArray(meta.themes)) themes = meta.themes.map(String);
        if (typeof meta.promoted_at === 'string') promotedAt = meta.promoted_at;
      } catch {
        /* ignore malformed meta */
      }
    }
    const text = trimmed.replace(/^-\s+/, '').replace(META_RE, '').trim();
    if (!text) continue;
    out.push({
      agentFolder,
      text,
      rawLine: trimmed,
      score,
      themes,
      promotedAt,
    });
  }
  return out;
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

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function aggregateEntries(entries: EngramEntry[]): SharedCandidate[] {
  const candidates: SharedCandidate[] = [];

  for (const e of entries) {
    const tokens = tokenize(e.text);
    let merged: SharedCandidate | null = null;
    for (const c of candidates) {
      if (jaccard(tokens, tokenize(c.representativeText)) >= 0.85) {
        merged = c;
        break;
      }
    }
    if (merged) {
      merged.agents.add(e.agentFolder);
      e.themes.forEach((t) => merged!.themes.add(t));
      merged.scoresByAgent.push(e.score);
      merged.rawLines.push({ agent: e.agentFolder, line: e.rawLine });
      if (
        e.promotedAt &&
        (!merged.latestPromotedAt || e.promotedAt > merged.latestPromotedAt)
      ) {
        merged.latestPromotedAt = e.promotedAt;
      }
    } else {
      candidates.push({
        textNormalized: normalizeKey(e.text),
        representativeText: e.text,
        agents: new Set([e.agentFolder]),
        themes: new Set(e.themes),
        scoresByAgent: [e.score],
        latestPromotedAt: e.promotedAt,
        rawLines: [{ agent: e.agentFolder, line: e.rawLine }],
      });
    }
  }

  return candidates;
}

interface ScoredShared {
  c: SharedCandidate;
  score: number;
  diversity: number;
}

function scoreShared(c: SharedCandidate, runMaxAgents: number): ScoredShared {
  const frequency =
    Math.log1p(c.agents.size) / Math.log1p(Math.max(runMaxAgents, 1));
  const relevance = c.scoresByAgent.length
    ? c.scoresByAgent.reduce((s, x) => s + x, 0) / c.scoresByAgent.length
    : 0.5;
  const queryDiversity = Math.min(c.agents.size / 3, 1);

  let recency = 0.5;
  if (c.latestPromotedAt) {
    const days = Math.max(
      0,
      (Date.now() - new Date(c.latestPromotedAt).getTime()) / 86400000,
    );
    recency = Math.exp(-days / Math.max(DREAM_RECENCY_HALFLIFE, 1));
  }

  const consolidation = Math.min(c.agents.size / 3, 1);
  const richness = Math.min(c.themes.size, 5) / 5;

  const total =
    0.24 * frequency +
    0.3 * relevance +
    0.15 * queryDiversity +
    0.15 * recency +
    0.1 * consolidation +
    0.06 * richness;

  return {
    c,
    score: Math.max(0, Math.min(1, total)),
    diversity: c.agents.size,
  };
}

function rehydrateShared(c: SharedCandidate): boolean {
  const tokens = tokenize(c.representativeText);
  if (tokens.size === 0) return false;
  for (const { agent } of c.rawLines) {
    const engramPath = path.join(AGENTS_DIR, agent, 'ENGRAM.md');
    if (!fs.existsSync(engramPath)) continue;
    const content = fs.readFileSync(engramPath, 'utf-8');
    const fileTokens = tokenize(content);
    let hits = 0;
    for (const t of tokens) if (fileTokens.has(t)) hits++;
    if (hits / tokens.size >= 0.6) return true;
  }
  return false;
}

interface MemoryLine {
  text: string;
  score: number;
}

function parseSharedMemory(content: string): MemoryLine[] {
  const lines: MemoryLine[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) continue;
    const m = trimmed.match(META_RE);
    let score = 0;
    if (m) {
      try {
        score = (JSON.parse(m[1]) as { score?: number }).score ?? 0;
      } catch {
        /* keep 0 */
      }
    }
    lines.push({ text: trimmed, score });
  }
  return lines;
}

function formatSharedLine(
  c: SharedCandidate,
  scored: ScoredShared,
  runDate: string,
): string {
  const oneLine = c.representativeText.replace(/\s+/g, ' ').trim();
  const meta = JSON.stringify({
    score: Number(scored.score.toFixed(3)),
    themes: [...c.themes],
    agents: [...c.agents],
    promoted_at: runDate,
  });
  return `- ${oneLine} <!-- meta: ${meta} -->`;
}

export interface SharedPromotion {
  text: string;
  score: number;
  agents: string[];
}

/**
 * Run the shared promotion step. Returns the promotions written to MEMORY.md.
 */
export function runSharedPromotion(
  registeredAgentFolders: string[],
): SharedPromotion[] {
  if (registeredAgentFolders.length === 0) return [];

  const all: EngramEntry[] = [];
  for (const folder of registeredAgentFolders) {
    const engramPath = path.join(AGENTS_DIR, folder, 'ENGRAM.md');
    if (!fs.existsSync(engramPath)) continue;
    try {
      const content = fs.readFileSync(engramPath, 'utf-8');
      all.push(...parseEngramFile(content, folder));
    } catch (err) {
      logger.warn(
        { err, folder },
        'Shared promotion: failed to read ENGRAM.md',
      );
    }
  }
  if (all.length === 0) return [];

  const candidates = aggregateEntries(all);
  const runMaxAgents = Math.max(...candidates.map((c) => c.agents.size), 1);
  const scored = candidates.map((c) => scoreShared(c, runMaxAgents));

  const survivors = scored.filter(
    ({ c, score, diversity }) =>
      score >= DREAM_MIN_SCORE &&
      c.agents.size >= DREAM_MIN_SUPPORT &&
      diversity >= DREAM_MIN_DIVERSITY,
  );

  const rehydrated = survivors.filter((s) => rehydrateShared(s.c));

  const runDate = new Date().toISOString().slice(0, 10);
  const newLines = rehydrated.map((s) => ({
    text: formatSharedLine(s.c, s, runDate),
    score: s.score,
  }));

  // Merge into context/MEMORY.md with 200-line cap by demotion.
  const memoryPath = path.join(CONTEXT_DIR, 'MEMORY.md');
  fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
  let existingContent = '';
  let preface = '';
  if (fs.existsSync(memoryPath)) {
    existingContent = fs.readFileSync(memoryPath, 'utf-8');
    // Preserve any leading non-list content (top-of-file headings/notes)
    const firstListIdx = existingContent.search(/^- /m);
    if (firstListIdx > 0) {
      preface = existingContent.slice(0, firstListIdx);
    } else if (firstListIdx === -1) {
      preface = existingContent;
    }
  }
  const existing = parseSharedMemory(existingContent);

  // Drop existing lines that match a new line (replace with newer score)
  const newKeys = new Set(
    newLines.map((l) => l.text.replace(META_RE, '').trim()),
  );
  const filtered = existing.filter(
    (l) => !newKeys.has(l.text.replace(META_RE, '').trim()),
  );

  const all2 = [...filtered, ...newLines]
    .sort((a, b) => b.score - a.score)
    .slice(0, DREAM_ENGRAM_LINE_CAP);

  const trimmedPreface = preface.trim();
  const body = all2.map((l) => l.text).join('\n');
  const out = (trimmedPreface ? trimmedPreface + '\n\n' : '') + body + '\n';
  fs.writeFileSync(memoryPath, out);

  const result: SharedPromotion[] = rehydrated.map((s) => ({
    text: s.c.representativeText,
    score: s.score,
    agents: [...s.c.agents],
  }));

  logger.info(
    {
      candidates: candidates.length,
      gated: survivors.length,
      promoted: result.length,
    },
    'Dream shared promotion complete',
  );
  return result;
}
