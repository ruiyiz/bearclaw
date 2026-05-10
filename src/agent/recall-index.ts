/**
 * BM25-ranked recall over an agent's conversation archives + crash-recovery
 * checkpoints. Backed by SQLite FTS5. Files are split into overlapping
 * line-window chunks; chunks are reindexed lazily when their source file's
 * mtime changes. Query path uses FTS5 `bm25()` for relevance ranking.
 */
import fs from 'fs';
import path from 'path';

import { agentVarDir } from '../config.js';
import { getDb } from '../db.js';
import { logger } from '../logger.js';

const CHUNK_LINES = 25;
const CHUNK_OVERLAP = 5;

interface FileRow {
  agent_folder: string;
  source: string;
  filename: string;
  mtime: number;
}

function chunkFile(content: string): {
  lineStart: number;
  lineEnd: number;
  text: string;
}[] {
  const lines = content.split('\n');
  const chunks: { lineStart: number; lineEnd: number; text: string }[] = [];
  const step = CHUNK_LINES - CHUNK_OVERLAP;
  for (let i = 0; i < lines.length; i += step) {
    const end = Math.min(lines.length, i + CHUNK_LINES);
    const slice = lines.slice(i, end);
    if (slice.every((l) => l.trim() === '')) {
      if (end >= lines.length) break;
      continue;
    }
    chunks.push({
      lineStart: i + 1,
      lineEnd: end,
      text: slice.join('\n'),
    });
    if (end >= lines.length) break;
  }
  return chunks;
}

function reindexFile(
  agentFolder: string,
  source: string,
  filename: string,
  fp: string,
  mtime: number,
): void {
  const db = getDb();
  let raw: string;
  try {
    raw = fs.readFileSync(fp, 'utf-8');
  } catch (err) {
    logger.warn({ err, fp }, 'recall: read failed during reindex');
    return;
  }
  const chunks = chunkFile(raw);

  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM recall_chunks WHERE agent_folder = ? AND source = ? AND filename = ?`,
    ).run(agentFolder, source, filename);

    const insert = db.prepare(
      `INSERT INTO recall_chunks (agent_folder, source, filename, line_start, line_end, content)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const c of chunks) {
      insert.run(agentFolder, source, filename, c.lineStart, c.lineEnd, c.text);
    }

    db.prepare(
      `INSERT INTO recall_files (agent_folder, source, filename, mtime)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_folder, source, filename) DO UPDATE SET mtime = excluded.mtime`,
    ).run(agentFolder, source, filename, mtime);
  });
  tx();
}

export interface SyncStats {
  scanned: number;
  reindexed: number;
  deleted: number;
}

export function syncRecallIndex(agentFolder: string): SyncStats {
  const db = getDb();
  const varDir = agentVarDir(agentFolder);
  const sources = ['conversations', 'checkpoints'];
  const stats: SyncStats = { scanned: 0, reindexed: 0, deleted: 0 };

  for (const source of sources) {
    const dir = path.join(varDir, source);
    const onDisk = new Map<string, number>();
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        const fp = path.join(dir, f);
        let mtime = 0;
        try {
          mtime = fs.statSync(fp).mtimeMs;
        } catch {
          continue;
        }
        onDisk.set(f, mtime);
      }
    }
    stats.scanned += onDisk.size;

    const indexed = db
      .prepare(
        `SELECT filename, mtime FROM recall_files WHERE agent_folder = ? AND source = ?`,
      )
      .all(agentFolder, source) as Pick<FileRow, 'filename' | 'mtime'>[];
    const indexedMap = new Map<string, number>(
      indexed.map((r) => [r.filename, r.mtime]),
    );

    for (const [filename, mtime] of onDisk) {
      const prev = indexedMap.get(filename);
      if (prev === undefined || prev !== mtime) {
        reindexFile(
          agentFolder,
          source,
          filename,
          path.join(dir, filename),
          mtime,
        );
        stats.reindexed += 1;
      }
    }

    const removeFiles = db.prepare(
      `DELETE FROM recall_files WHERE agent_folder = ? AND source = ? AND filename = ?`,
    );
    const removeChunks = db.prepare(
      `DELETE FROM recall_chunks WHERE agent_folder = ? AND source = ? AND filename = ?`,
    );
    for (const filename of indexedMap.keys()) {
      if (!onDisk.has(filename)) {
        removeChunks.run(agentFolder, source, filename);
        removeFiles.run(agentFolder, source, filename);
        stats.deleted += 1;
      }
    }
  }

  return stats;
}

export interface RecallHit {
  source: string;
  filename: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  score: number;
}

const FTS_SPECIAL = /[^\p{L}\p{N}\s"]/gu;

function sanitizeQuery(raw: string): string {
  const cleaned = raw.replace(FTS_SPECIAL, ' ').trim();
  if (!cleaned) return '';
  return cleaned;
}

export function queryRecall(
  agentFolder: string,
  query: string,
  limit = 20,
): RecallHit[] {
  const db = getDb();
  const trimmed = query.trim();
  if (!trimmed) return [];

  const tryQueries = [
    trimmed,
    sanitizeQuery(trimmed),
    sanitizeQuery(trimmed)
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t}"`)
      .join(' OR '),
  ].filter((q, i, a) => q && a.indexOf(q) === i);

  let rows: unknown[] = [];
  let lastErr: Error | null = null;
  for (const q of tryQueries) {
    try {
      rows = db
        .prepare(
          `SELECT c.source, c.filename, c.line_start, c.line_end, c.content,
                  bm25(recall_fts) AS score
           FROM recall_fts
           JOIN recall_chunks c ON c.id = recall_fts.rowid
           WHERE recall_fts MATCH ? AND c.agent_folder = ?
           ORDER BY score
           LIMIT ?`,
        )
        .all(q, agentFolder, limit);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err as Error;
    }
  }
  if (lastErr) {
    logger.warn({ err: lastErr, query }, 'recall: all FTS query forms failed');
    return [];
  }

  return (
    rows as {
      source: string;
      filename: string;
      line_start: number;
      line_end: number;
      content: string;
      score: number;
    }[]
  ).map((r) => ({
    source: r.source,
    filename: r.filename,
    lineStart: r.line_start,
    lineEnd: r.line_end,
    text: r.content,
    score: r.score,
  }));
}
