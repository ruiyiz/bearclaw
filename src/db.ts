import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';
import {
  EventRecord,
  Handler,
  HandlerRunLog,
  NewMessage,
} from './types.js';

let db: Database.Database;

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      emitted_at TEXT NOT NULL,
      processed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_events_processed ON events(processed);

    CREATE TABLE IF NOT EXISTS handlers (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      prompt TEXT NOT NULL,
      context_mode TEXT NOT NULL DEFAULT 'isolated',
      event_type TEXT NOT NULL,
      filter TEXT,
      cron TEXT,
      next_run TEXT,
      cooldown_ms INTEGER NOT NULL DEFAULT 0,
      last_triggered TEXT,
      max_triggers INTEGER,
      trigger_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_handlers_event_type ON handlers(event_type);
    CREATE INDEX IF NOT EXISTS idx_handlers_status ON handlers(status);
    CREATE INDEX IF NOT EXISTS idx_handlers_next_run ON handlers(next_run);

    CREATE TABLE IF NOT EXISTS handler_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      handler_id TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (handler_id) REFERENCES handlers(id),
      FOREIGN KEY (event_id) REFERENCES events(id)
    );
    CREATE INDEX IF NOT EXISTS idx_handler_logs ON handler_logs(handler_id, run_at);
  `);

  // Add sender_name column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN sender_name TEXT`);
  } catch {
    /* column already exists */
  }

  // Migrate old tables to unified handlers table
  migrateToUnifiedHandlers();

  // Rename context_mode 'group' → 'agent'
  db.exec(`UPDATE handlers SET context_mode = 'agent' WHERE context_mode = 'group'`);

  initMemoryFts();
}

function intervalToCron(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes <= 0) return '* * * * *';
  if (minutes <= 59) return `*/${minutes} * * * *`;
  const hours = Math.round(ms / 3600000);
  if (hours <= 23) return `0 */${hours} * * *`;
  return '0 0 * * *'; // daily fallback
}

function migrateToUnifiedHandlers(): void {
  const hasEventHandlers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='event_handlers'",
  ).get();

  const hasScheduledTasks = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'",
  ).get();

  if (!hasEventHandlers && !hasScheduledTasks) return;

  const migrate = db.transaction(() => {
    // Migrate event_handlers → handlers
    if (hasEventHandlers) {
      const rows = db.prepare('SELECT * FROM event_handlers').all() as Array<Record<string, unknown>>;
      for (const h of rows) {
        const exists = db.prepare('SELECT id FROM handlers WHERE id = ?').get(h.id);
        if (exists) continue;

        db.prepare(
          `INSERT INTO handlers (id, group_folder, prompt, context_mode, event_type, filter, cron, next_run, cooldown_ms, last_triggered, max_triggers, trigger_count, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
        ).run(
          h.id, h.group_folder, h.prompt, h.context_mode || 'isolated',
          h.event_type, h.filter,
          h.cooldown_ms || 0, h.last_triggered,
          h.max_triggers ?? null, h.trigger_count || 0,
          h.status || 'active', h.created_at,
        );
      }
    }

    // Migrate scheduled_tasks → handlers
    if (hasScheduledTasks) {
      // Ensure context_mode column exists on old table
      try {
        db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`);
      } catch { /* column already exists */ }

      const rows = db.prepare('SELECT * FROM scheduled_tasks').all() as Array<Record<string, unknown>>;
      for (const t of rows) {
        const handlerId = `migrated-${t.id}`;
        const exists = db.prepare('SELECT id FROM handlers WHERE id = ?').get(handlerId);
        if (exists) continue;

        let cron: string | null = null;
        const nextRun = t.next_run as string | null;
        let maxTriggers: number | null = null;

        if (t.schedule_type === 'cron') {
          cron = t.schedule_value as string;
        } else if (t.schedule_type === 'interval') {
          cron = intervalToCron(parseInt(t.schedule_value as string, 10));
        } else if (t.schedule_type === 'once') {
          maxTriggers = 1;
        }

        const filter = JSON.stringify({ handler_id: handlerId });

        db.prepare(
          `INSERT INTO handlers (id, group_folder, prompt, context_mode, event_type, filter, cron, next_run, cooldown_ms, last_triggered, max_triggers, trigger_count, status, created_at)
           VALUES (?, ?, ?, ?, 'cron_trigger', ?, ?, ?, 0, ?, ?, 0, ?, ?)`,
        ).run(
          handlerId, t.group_folder, t.prompt,
          (t.context_mode as string) || 'isolated',
          filter, cron, nextRun,
          t.last_run as string | null,
          maxTriggers,
          t.status || 'active', t.created_at,
        );
      }
    }

    // Drop old tables
    db.exec('DROP TABLE IF EXISTS event_handler_logs');
    db.exec('DROP TABLE IF EXISTS event_handlers');
    db.exec('DROP TABLE IF EXISTS task_run_logs');
    db.exec('DROP TABLE IF EXISTS scheduled_tasks');
  });

  migrate();
  logger.info('Migrated to unified handlers table');
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
): void {
  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, name, timestamp);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, chatJid, timestamp);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(msg.id, msg.chat_jid, msg.sender, msg.sender_name, msg.content, msg.timestamp, 0);
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefixes: string[],
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter out bot's own messages by checking content prefix (not is_from_me, since user shares the account)
  const prefixFilters = botPrefixes.map(() => 'content NOT LIKE ?').join(' AND ');
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders}) AND ${prefixFilters}
    ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, ...botPrefixes.map(p => `${p}:%`)) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefixes: string[],
): NewMessage[] {
  // Filter out bot's own messages by checking content prefix
  const prefixFilters = botPrefixes.map(() => 'content NOT LIKE ?').join(' AND ');
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ? AND ${prefixFilters}
    ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, ...botPrefixes.map(p => `${p}:%`)) as NewMessage[];
}

// ─── Event functions ───────────────────────────────────────────────────────

export function emitEvent(type: string, payload: object): number {
  const result = db
    .prepare(
      `INSERT INTO events (type, payload, emitted_at, processed) VALUES (?, ?, ?, 0)`,
    )
    .run(type, JSON.stringify(payload), new Date().toISOString());
  return result.lastInsertRowid as number;
}

export function getUnprocessedEvents(): EventRecord[] {
  return db
    .prepare(`SELECT * FROM events WHERE processed = 0 ORDER BY id`)
    .all() as EventRecord[];
}

export function markEventProcessed(id: number): void {
  db.prepare(`UPDATE events SET processed = 1 WHERE id = ?`).run(id);
}

export function cleanupProcessedEvents(): void {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  // handler_logs.event_id is a FK into events.id; delete dependent rows first
  // so the events DELETE doesn't trip a FOREIGN KEY constraint failure.
  db.transaction(() => {
    db.prepare(
      `DELETE FROM handler_logs
       WHERE event_id IN (
         SELECT id FROM events WHERE processed = 1 AND emitted_at < ?
       )`,
    ).run(cutoff);
    db.prepare(
      `DELETE FROM events WHERE processed = 1 AND emitted_at < ?`,
    ).run(cutoff);
  })();
}

// ─── Handler matching ──────────────────────────────────────────────────────

export function getMatchingHandlers(event: EventRecord): Handler[] {
  const handlers = db
    .prepare(
      `SELECT * FROM handlers WHERE event_type = ? AND status = 'active'`,
    )
    .all(event.type) as Handler[];

  const now = Date.now();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(event.payload);
  } catch {
    payload = {};
  }

  return handlers.filter((h) => {
    // Check cooldown
    if (h.cooldown_ms > 0 && h.last_triggered) {
      const elapsed = now - new Date(h.last_triggered).getTime();
      if (elapsed < h.cooldown_ms) return false;
    }

    // Check max_triggers
    if (h.max_triggers !== null && h.trigger_count >= h.max_triggers) {
      return false;
    }

    // Check filter (all keys must match payload)
    if (h.filter) {
      try {
        const filter = JSON.parse(h.filter) as Record<string, unknown>;
        for (const [key, value] of Object.entries(filter)) {
          if (payload[key] !== value) return false;
        }
      } catch {
        return false;
      }
    }

    return true;
  });
}

export function updateHandlerAfterTrigger(id: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE handlers SET trigger_count = trigger_count + 1, last_triggered = ? WHERE id = ?`,
  ).run(now, id);

  // Auto-complete if max_triggers reached
  const handler = db
    .prepare(`SELECT max_triggers, trigger_count FROM handlers WHERE id = ?`)
    .get(id) as { max_triggers: number | null; trigger_count: number } | undefined;
  if (handler && handler.max_triggers !== null && handler.trigger_count >= handler.max_triggers) {
    db.prepare(`UPDATE handlers SET status = 'completed' WHERE id = ?`).run(id);
  }
}

// ─── Cron scheduling ──────────────────────────────────────────────────────

export function getCronDueHandlers(): Handler[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `SELECT * FROM handlers
       WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
       ORDER BY next_run`,
    )
    .all(now) as Handler[];
}

export function updateHandlerNextRun(id: string, nextRun: string | null): void {
  db.prepare('UPDATE handlers SET next_run = ? WHERE id = ?').run(nextRun, id);
}

// ─── Handler CRUD ──────────────────────────────────────────────────────────

export function createHandler(
  handler: Omit<Handler, 'last_triggered' | 'trigger_count'>,
): void {
  db.prepare(
    `INSERT INTO handlers (id, group_folder, prompt, context_mode, event_type, filter, cron, next_run, cooldown_ms, last_triggered, max_triggers, trigger_count, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)`,
  ).run(
    handler.id,
    handler.group_folder,
    handler.prompt,
    handler.context_mode || 'isolated',
    handler.event_type,
    handler.filter,
    handler.cron ?? null,
    handler.next_run ?? null,
    handler.cooldown_ms || 0,
    handler.max_triggers ?? null,
    handler.status,
    handler.created_at,
  );
}

export function getHandlerById(id: string): Handler | undefined {
  return db
    .prepare('SELECT * FROM handlers WHERE id = ?')
    .get(id) as Handler | undefined;
}

export function getAllHandlers(): Handler[] {
  return db
    .prepare('SELECT * FROM handlers ORDER BY created_at DESC')
    .all() as Handler[];
}

export function getHandlersForAgent(agentFolder: string): Handler[] {
  return db
    .prepare(
      'SELECT * FROM handlers WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(agentFolder) as Handler[];
}

export function updateHandler(
  id: string,
  updates: Partial<Pick<Handler, 'prompt' | 'filter' | 'cooldown_ms' | 'max_triggers' | 'status'>>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.filter !== undefined) {
    fields.push('filter = ?');
    values.push(updates.filter);
  }
  if (updates.cooldown_ms !== undefined) {
    fields.push('cooldown_ms = ?');
    values.push(updates.cooldown_ms);
  }
  if (updates.max_triggers !== undefined) {
    fields.push('max_triggers = ?');
    values.push(updates.max_triggers);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE handlers SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteHandler(id: string): void {
  db.prepare('DELETE FROM handler_logs WHERE handler_id = ?').run(id);
  db.prepare('DELETE FROM handlers WHERE id = ?').run(id);
}

export function logHandlerRun(log: HandlerRunLog): void {
  db.prepare(
    `INSERT INTO handler_logs (handler_id, event_id, run_at, duration_ms, status, result, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    log.handler_id,
    log.event_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// ─── Memory FTS ──────────────────────────────────────────────────────────

function initMemoryFts(): void {
  const hasFts = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'",
  ).get();

  if (!hasFts) {
    db.exec(`
      CREATE VIRTUAL TABLE memory_fts USING fts5(
        content,
        path UNINDEXED,
        group_folder UNINDEXED
      );
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_files (
      path TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      PRIMARY KEY (path, group_folder)
    );
  `);
}

export function indexMemoryFiles(agentFolder: string, agentDir: string): void {
  const dirs = [
    { dir: path.join(agentDir, 'memory'), prefix: 'memory' },
    { dir: path.join(agentDir, 'conversations'), prefix: 'conversations' },
  ];

  const currentFiles = new Map<string, number>();

  for (const { dir, prefix } of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      const relPath = `${prefix}/${file}`;
      currentFiles.set(relPath, stat.mtimeMs);
    }
  }

  // Get already-indexed files for this agent
  const indexed = db.prepare(
    'SELECT path, mtime FROM memory_files WHERE group_folder = ?',
  ).all(agentFolder) as Array<{ path: string; mtime: number }>;

  const indexedMap = new Map(indexed.map((r) => [r.path, r.mtime]));

  const upsert = db.transaction(() => {
    // Remove deleted files
    for (const [iPath] of indexedMap) {
      if (!currentFiles.has(iPath)) {
        db.prepare('DELETE FROM memory_fts WHERE path = ? AND group_folder = ?').run(iPath, agentFolder);
        db.prepare('DELETE FROM memory_files WHERE path = ? AND group_folder = ?').run(iPath, agentFolder);
      }
    }

    // Index new/changed files
    for (const [relPath, mtime] of currentFiles) {
      const existingMtime = indexedMap.get(relPath);
      if (existingMtime !== undefined && Math.abs(existingMtime - mtime) < 1000) continue;

      const prefix = relPath.split('/')[0];
      const fullPath = path.join(agentDir, relPath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (!content.trim()) continue;

      // Remove old entry
      db.prepare('DELETE FROM memory_fts WHERE path = ? AND group_folder = ?').run(relPath, agentFolder);
      db.prepare('DELETE FROM memory_files WHERE path = ? AND group_folder = ?').run(relPath, agentFolder);

      // Insert new
      db.prepare('INSERT INTO memory_fts (content, path, group_folder) VALUES (?, ?, ?)').run(content, relPath, agentFolder);
      db.prepare('INSERT INTO memory_files (path, group_folder, mtime) VALUES (?, ?, ?)').run(relPath, agentFolder, mtime);
    }
  });

  upsert();
}

export interface MemorySearchResult {
  path: string;
  snippet: string;
  rank: number;
}

export function searchMemory(
  agentFolder: string,
  query: string,
  limit = 10,
): MemorySearchResult[] {
  // Escape FTS5 special characters for safe querying
  const safeQuery = query.replace(/["*(){}[\]:^~!]/g, ' ').trim();
  if (!safeQuery) return [];

  return db.prepare(`
    SELECT
      path,
      snippet(memory_fts, 0, '>>>', '<<<', '...', 40) as snippet,
      rank
    FROM memory_fts
    WHERE memory_fts MATCH ? AND group_folder = ?
    ORDER BY rank
    LIMIT ?
  `).all(safeQuery, agentFolder, limit) as MemorySearchResult[];
}
