/**
 * Dream Cycle — Light phase (deterministic).
 *
 * Reads the lookback-window daily memory logs and conversation summaries,
 * splits into snippet candidates on `## ` headings, dedupes via Jaccard
 * similarity against existing candidates, and upserts into dream_candidates.
 * Never writes ENGRAM.md or MEMORY.md.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DREAM_LOOKBACK_DAYS } from '../config.js';
import { upsertDreamCandidate } from '../db.js';
import { logger } from '../logger.js';

const JACCARD_THRESHOLD = 0.85;

function hash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);
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
  if (a.size === 0 && b.size === 0) return 1;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  const union = a.size + b.size - intersect;
  return union ? intersect / union : 0;
}

function normalize(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strip event-handler boilerplate, MCP tool references, transcript framing.
 * Returns null if what's left is too thin to be useful.
 */
function cleanSnippet(raw: string): string | null {
  let s = raw;
  s = s.replace(/\[EVENT TRIGGERED[\s\S]*?\]/gi, '');
  s = s.replace(/<event[\s\S]*?<\/event>/gi, '');
  s = s.replace(/<handler_instructions>[\s\S]*?<\/handler_instructions>/gi, '');
  // Strip transcript wrappers (also handle truncated/unclosed forms)
  s = s.replace(/<\/?messages>/gi, '');
  s = s.replace(/<message[^>]*>/gi, ' ');
  s = s.replace(/<\/message>/gi, ' ');
  s = s.replace(/^\s*[-*]\s*(?:User|Assistant|Andy|CoCo):\s*/gim, '');
  s = s.replace(/^\s*\*\*(?:User|Assistant|Andy|CoCo)\*\*:\s*/gim, '');
  s = s.replace(/mcp__\w+__\w+/g, '');
  s = s.replace(/^#\s+Conversation\s+Archived:.*$/gim, '');
  s = normalize(s);
  if (s.length < 30 || s.length > 1500) return null;
  return s;
}

const SECTION_HEADER =
  /^(?:##\s+[^\n]*|\*\*(?:User|Assistant|Andy|CoCo)\*\*:|\s*[-*]\s*(?:User|Assistant|Andy|CoCo):)/m;

/**
 * Split markdown into snippets. Boundaries: H2 headers, **User**:/**Andy**:
 * transcript markers, and `- User:`/`- Assistant:` bullet rolls. Each segment
 * is then cleaned of boilerplate.
 */
function extractSnippets(content: string): string[] {
  const lines = content.split('\n');
  const segments: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) {
      segments.push(buf.join('\n'));
      buf = [];
    }
  };
  for (const line of lines) {
    if (SECTION_HEADER.test(line) && buf.length) flush();
    buf.push(line);
  }
  flush();

  const out: string[] = [];
  for (const seg of segments) {
    const cleaned = cleanSnippet(seg);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

function extractDateFromFilename(filename: string): string | null {
  const m = filename.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function isWithinLookback(filename: string, cutoffDate: string): boolean {
  const d = extractDateFromFilename(filename);
  if (!d) return true; // conversations without dates: include conservatively
  return d >= cutoffDate;
}

function cutoffDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - DREAM_LOOKBACK_DAYS);
  return d.toISOString().slice(0, 10);
}

/**
 * Run the Light phase for one agent.
 * Returns the number of distinct candidates seen this run.
 *
 * `varDir` is the agent's runtime directory (var/agents/{folder}) where
 * memory/ and conversations/ live.
 */
export function runLightPhase(agentFolder: string, varDir: string): number {
  const cutoff = cutoffDate();
  const now = Math.floor(Date.now() / 1000);

  const sources: Array<{ relPath: string; content: string }> = [];

  for (const sub of ['memory', 'conversations']) {
    const dir = path.join(varDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.md')) continue;
      if (!isWithinLookback(f, cutoff)) continue;
      try {
        const fullPath = path.join(dir, f);
        const content = fs.readFileSync(fullPath, 'utf-8');
        sources.push({ relPath: `${sub}/${f}`, content });
      } catch (err) {
        logger.warn({ err, file: f }, 'Light phase: failed to read source');
      }
    }
  }

  // In-batch dedupe: token sets keyed by snippet hash
  const seen: Array<{ tokens: Set<string>; hash: string }> = [];
  let count = 0;

  for (const { relPath, content } of sources) {
    for (const snippet of extractSnippets(content)) {
      const tokens = tokenize(snippet);
      let collapsedHash: string | null = null;
      for (const s of seen) {
        if (jaccard(tokens, s.tokens) >= JACCARD_THRESHOLD) {
          collapsedHash = s.hash;
          break;
        }
      }
      const finalHash = collapsedHash ?? hash(snippet);
      if (!collapsedHash) seen.push({ tokens, hash: finalHash });

      upsertDreamCandidate(agentFolder, snippet, finalHash, relPath, now);
      count++;
    }
  }

  logger.info(
    { agentFolder, count, sources: sources.length },
    'Dream Light phase complete',
  );
  return count;
}
