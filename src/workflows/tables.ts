import type Database from 'better-sqlite3';

export function initWorkflowTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      slug        TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      owner       TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      definition  TEXT NOT NULL,
      last_run_id TEXT,
      last_status TEXT,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_triggers (
      id           TEXT PRIMARY KEY,
      slug         TEXT NOT NULL,
      type         TEXT NOT NULL,
      source       TEXT NOT NULL DEFAULT 'runtime',
      config       TEXT NOT NULL DEFAULT '{}',
      args         TEXT NOT NULL DEFAULT '{}',
      enabled      INTEGER NOT NULL DEFAULT 1,
      next_run_at  TEXT,
      last_run_id  TEXT,
      last_fired_at TEXT,
      created_by   TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wf_triggers_slug ON workflow_triggers(slug);
    CREATE INDEX IF NOT EXISTS idx_wf_triggers_next ON workflow_triggers(next_run_at);

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id              TEXT PRIMARY KEY,
      slug            TEXT NOT NULL,
      trigger_id      TEXT,
      definition      TEXT NOT NULL,
      definition_hash TEXT NOT NULL,
      run_key         TEXT UNIQUE,
      inputs          TEXT NOT NULL DEFAULT '{}',
      trigger_payload TEXT,
      status          TEXT NOT NULL,
      context         TEXT NOT NULL DEFAULT '{}',
      started_at      TEXT NOT NULL,
      finished_at     TEXT,
      error           TEXT,
      parent_run_id   TEXT,
      forked_at_node  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wf_runs_slug ON workflow_runs(slug, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wf_runs_status ON workflow_runs(status);

    CREATE TABLE IF NOT EXISTS workflow_steps (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id           TEXT NOT NULL,
      node_id          TEXT NOT NULL,
      attempt          INTEGER NOT NULL DEFAULT 1,
      status           TEXT NOT NULL,
      port             TEXT,
      input            TEXT,
      output           TEXT,
      error            TEXT,
      log_path         TEXT,
      agent_session_id TEXT,
      started_at       TEXT NOT NULL,
      finished_at      TEXT,
      UNIQUE (run_id, node_id, attempt)
    );
    CREATE INDEX IF NOT EXISTS idx_wf_steps_run ON workflow_steps(run_id);

    CREATE TABLE IF NOT EXISTS workflow_waits (
      id            TEXT PRIMARY KEY,
      run_id        TEXT NOT NULL,
      node_id       TEXT NOT NULL,
      attempt       INTEGER NOT NULL DEFAULT 1,
      kind          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'open',
      prompt        TEXT,
      options       TEXT,
      targets       TEXT,
      fields        TEXT,
      event_type    TEXT,
      filter        TEXT,
      event_floor   INTEGER,
      resume_at     TEXT,
      on_timeout    TEXT,
      token_hash    TEXT,
      response      TEXT,
      responder     TEXT,
      responded_via TEXT,
      created_at    TEXT NOT NULL,
      resolved_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wf_waits_open ON workflow_waits(status, resume_at);
    CREATE INDEX IF NOT EXISTS idx_wf_waits_run ON workflow_waits(run_id);

    CREATE TABLE IF NOT EXISTS workflow_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id  TEXT NOT NULL,
      ts      TEXT NOT NULL,
      node_id TEXT,
      kind    TEXT NOT NULL,
      payload TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wf_events_run ON workflow_events(run_id, id);
  `);
}
