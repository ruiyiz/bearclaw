import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { EventRecord, Handler, HandlerRunLog, NewMessage } from './types.js';

let db: Database.Database;

export function getDb(): Database.Database {
  return db;
}

export function initDatabase(): void {
  const dbPath = path.join(DATA_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  // Pre-cutover dbs hold a `memory_vec` virtual table that needs the vec0
  // loadable extension just to be dropped. Load it before the migration so
  // the DROP succeeds; after that, the extension is unused.
  try {
    sqliteVec.load(db);
  } catch (err) {
    logger.debug(
      { err },
      'sqlite-vec not loaded (no legacy memory_vec to drop)',
    );
  }
  dropLegacyMemoryAndDreamTables();
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

    CREATE TABLE IF NOT EXISTS recall_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_folder TEXT NOT NULL,
      source TEXT NOT NULL,
      filename TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      content TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recall_file ON recall_chunks(agent_folder, source, filename);

    CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(
      content,
      content=recall_chunks,
      content_rowid=id,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS recall_chunks_ai AFTER INSERT ON recall_chunks BEGIN
      INSERT INTO recall_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS recall_chunks_ad AFTER DELETE ON recall_chunks BEGIN
      INSERT INTO recall_fts(recall_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;

    CREATE TABLE IF NOT EXISTS recall_files (
      agent_folder TEXT NOT NULL,
      source TEXT NOT NULL,
      filename TEXT NOT NULL,
      mtime REAL NOT NULL,
      PRIMARY KEY (agent_folder, source, filename)
    );
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
  db.exec(
    `UPDATE handlers SET context_mode = 'agent' WHERE context_mode = 'group'`,
  );
}

function dropLegacyMemoryAndDreamTables(): void {
  // Long-term memory now lives in gbrain. Drop the FTS/vector/dream tables
  // that the old in-process pipeline owned. Idempotent: every drop guards
  // on IF EXISTS so re-runs are no-ops.
  db.exec(`
    DROP TABLE IF EXISTS memory_vec;
    DROP TABLE IF EXISTS memory_chunks;
    DROP TABLE IF EXISTS memory_fts;
    DROP TABLE IF EXISTS memory_files;
    DROP TABLE IF EXISTS dream_candidates;
    DROP TABLE IF EXISTS dream_runs;
    DROP TABLE IF EXISTS dream_reports;
  `);
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
  const hasEventHandlers = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='event_handlers'",
    )
    .get();

  const hasScheduledTasks = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'",
    )
    .get();

  if (!hasEventHandlers && !hasScheduledTasks) return;

  const migrate = db.transaction(() => {
    // Migrate event_handlers → handlers
    if (hasEventHandlers) {
      const rows = db.prepare('SELECT * FROM event_handlers').all() as Array<
        Record<string, unknown>
      >;
      for (const h of rows) {
        const exists = db
          .prepare('SELECT id FROM handlers WHERE id = ?')
          .get(h.id);
        if (exists) continue;

        db.prepare(
          `INSERT INTO handlers (id, group_folder, prompt, context_mode, event_type, filter, cron, next_run, cooldown_ms, last_triggered, max_triggers, trigger_count, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
        ).run(
          h.id,
          h.group_folder,
          h.prompt,
          h.context_mode || 'isolated',
          h.event_type,
          h.filter,
          h.cooldown_ms || 0,
          h.last_triggered,
          h.max_triggers ?? null,
          h.trigger_count || 0,
          h.status || 'active',
          h.created_at,
        );
      }
    }

    // Migrate scheduled_tasks → handlers
    if (hasScheduledTasks) {
      // Ensure context_mode column exists on old table
      try {
        db.exec(
          `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
        );
      } catch {
        /* column already exists */
      }

      const rows = db.prepare('SELECT * FROM scheduled_tasks').all() as Array<
        Record<string, unknown>
      >;
      for (const t of rows) {
        const handlerId = `migrated-${t.id}`;
        const exists = db
          .prepare('SELECT id FROM handlers WHERE id = ?')
          .get(handlerId);
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
          handlerId,
          t.group_folder,
          t.prompt,
          (t.context_mode as string) || 'isolated',
          filter,
          cron,
          nextRun,
          t.last_run as string | null,
          maxTriggers,
          t.status || 'active',
          t.created_at,
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

interface ChatInfo {
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

export function storeMessage(msg: NewMessage, isFromMe = 0): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    isFromMe ? 1 : 0,
  );
}

export interface StoredMessage extends NewMessage {
  is_from_me: number;
}

export function getMessagesByJid(
  chatJid: string,
  before: string | null,
  limit: number,
): StoredMessage[] {
  const sql = before
    ? `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
       FROM messages
       WHERE chat_jid = ? AND timestamp < ?
       ORDER BY timestamp DESC
       LIMIT ?`
    : `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
       FROM messages
       WHERE chat_jid = ?
       ORDER BY timestamp DESC
       LIMIT ?`;
  const args: unknown[] = before ? [chatJid, before, limit] : [chatJid, limit];
  return db.prepare(sql).all(...args) as StoredMessage[];
}

export function getMessagesByJids(
  chatJids: string[],
  before: string | null,
  limit: number,
): StoredMessage[] {
  if (chatJids.length === 0) return [];
  const placeholders = chatJids.map(() => '?').join(',');
  const sql = before
    ? `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
       FROM messages
       WHERE chat_jid IN (${placeholders}) AND timestamp < ?
       ORDER BY timestamp DESC
       LIMIT ?`
    : `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
       FROM messages
       WHERE chat_jid IN (${placeholders})
       ORDER BY timestamp DESC
       LIMIT ?`;
  const args: unknown[] = before
    ? [...chatJids, before, limit]
    : [...chatJids, limit];
  return db.prepare(sql).all(...args) as StoredMessage[];
}

export function updateMessageContent(
  id: string,
  chatJid: string,
  content: string,
): void {
  db.prepare(
    `UPDATE messages SET content = ? WHERE id = ? AND chat_jid = ?`,
  ).run(content, id, chatJid);
}

export function deleteMessageById(id: string, chatJid: string): void {
  db.prepare(`DELETE FROM messages WHERE id = ? AND chat_jid = ?`).run(
    id,
    chatJid,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders}) AND is_from_me = 0
    ORDER BY timestamp
  `;

  const rows = db.prepare(sql).all(lastTimestamp, ...jids) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
): NewMessage[] {
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ? AND is_from_me = 0
    ORDER BY timestamp
  `;
  return db.prepare(sql).all(chatJid, sinceTimestamp) as NewMessage[];
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
    db.prepare(`DELETE FROM events WHERE processed = 1 AND emitted_at < ?`).run(
      cutoff,
    );
  })();
}

// ─── Handler matching ──────────────────────────────────────────────────────

export function getMatchingHandlers(event: EventRecord): Handler[] {
  const allHandlers = db
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

  // cron_trigger events target a specific handler by id. Match on the
  // primary key directly so renames don't silently break dispatch.
  const handlers =
    event.type === 'cron_trigger' && typeof payload.handler_id === 'string'
      ? allHandlers.filter((h) => h.id === payload.handler_id)
      : allHandlers;

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

    // Check filter (all keys must match payload). Skipped for cron_trigger
    // since dispatch is already by handler id above.
    if (h.filter && event.type !== 'cron_trigger') {
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
    .get(id) as
    | { max_triggers: number | null; trigger_count: number }
    | undefined;
  if (
    handler &&
    handler.max_triggers !== null &&
    handler.trigger_count >= handler.max_triggers
  ) {
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
  return db.prepare('SELECT * FROM handlers WHERE id = ?').get(id) as
    | Handler
    | undefined;
}

export function getAllHandlers(): Handler[] {
  return db
    .prepare('SELECT * FROM handlers ORDER BY created_at DESC')
    .all() as Handler[];
}

export function updateHandler(
  id: string,
  updates: Partial<
    Pick<
      Handler,
      'prompt' | 'filter' | 'cooldown_ms' | 'max_triggers' | 'status'
    >
  >,
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
  db.prepare(`UPDATE handlers SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
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
