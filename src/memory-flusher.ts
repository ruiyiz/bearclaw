import fs from 'fs';
import os from 'os';
import path from 'path';

import { AGENTS_DIR, MEMORY_FLUSH_INTERVAL, localDate, localTime } from './config.js';
import { logger } from './logger.js';
import {
  formatTranscriptMarkdown,
  generateFallbackName,
  getSessionSummary,
  parseTranscript,
  sanitizeFilename,
} from './agent-runner.js';

interface MemoryFlusherDeps {
  getSessions: () => Record<string, string>;
}

// sessionId -> number of lines already flushed
const cursors = new Map<string, number>();

function getTranscriptPath(agentDir: string, sessionId: string): string {
  const encodedCwd = agentDir.replace(/[/.]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encodedCwd, `${sessionId}.jsonl`);
}

function flushSession(folder: string, sessionId: string, agentDir: string, isFinal: boolean): void {
  const transcriptPath = getTranscriptPath(agentDir, sessionId);

  if (!fs.existsSync(transcriptPath)) {
    if (isFinal) cursors.delete(sessionId);
    return;
  }

  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const allLines = content.split('\n').filter((l) => l.trim());
  const cursor = cursors.get(sessionId) ?? 0;
  const newLines = allLines.slice(cursor);

  if (newLines.length === 0 && !isFinal) return;

  const newMessages = parseTranscript(newLines.join('\n'));
  const date = localDate();
  const time = localTime();
  const memoryDir = path.join(agentDir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const memoryFile = path.join(memoryDir, `${date}.md`);

  if (newMessages.length > 0) {
    const heading = isFinal ? `## Session ended (${time})` : `## Session update (${time})`;
    const contextLines = newMessages.map((m) => {
      const prefix = m.role === 'user' ? 'User' : 'Assistant';
      const text = m.content.length > 300 ? m.content.slice(0, 300) + '...' : m.content;
      return `  - ${prefix}: ${text}`;
    });
    const entry = ['', heading, '', ...contextLines, ''].join('\n');
    fs.appendFileSync(memoryFile, entry);
    logger.debug({ memoryFile, isFinal }, 'Memory flush written');
  }

  if (isFinal) {
    const allMessages = parseTranscript(content);
    if (allMessages.length > 0) {
      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();
      const conversationsDir = path.join(agentDir, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);
      fs.writeFileSync(filePath, formatTranscriptMarkdown(allMessages, summary));
      logger.debug({ filePath }, 'Archived conversation');
    }
    cursors.delete(sessionId);
  } else {
    cursors.set(sessionId, allLines.length);
  }
}

export function initFlushCursors(sessions: Record<string, string>): void {
  for (const [folder, sessionId] of Object.entries(sessions)) {
    const agentDir = path.join(AGENTS_DIR, folder);
    const transcriptPath = getTranscriptPath(agentDir, sessionId);
    if (fs.existsSync(transcriptPath)) {
      const lines = fs.readFileSync(transcriptPath, 'utf-8').split('\n').filter((l) => l.trim());
      cursors.set(sessionId, lines.length);
      logger.debug({ folder, sessionId, lineCount: lines.length }, 'Flush cursor initialized');
    }
  }
}

export function flushBeforeSessionClear(folder: string, sessionId: string): void {
  const agentDir = path.join(AGENTS_DIR, folder);
  try {
    flushSession(folder, sessionId, agentDir, true);
  } catch (err) {
    logger.error({ err, folder }, 'Memory flush error on session clear');
  }
}

export function startMemoryFlusher(deps: MemoryFlusherDeps): void {
  const flush = () => {
    const sessions = deps.getSessions();
    for (const [folder, sessionId] of Object.entries(sessions)) {
      const agentDir = path.join(AGENTS_DIR, folder);
      try {
        flushSession(folder, sessionId, agentDir, false);
      } catch (err) {
        logger.error({ err, folder }, 'Memory flush error');
      }
    }
    setTimeout(flush, MEMORY_FLUSH_INTERVAL);
  };

  setTimeout(flush, MEMORY_FLUSH_INTERVAL);
  logger.info({ intervalMs: MEMORY_FLUSH_INTERVAL }, 'Memory flusher started');
}
