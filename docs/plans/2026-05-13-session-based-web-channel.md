# Session-Based Web Channel

Make the web UI behave like Claude.ai / ChatGPT: each conversation is its own
persistent thread under an agent. IM channels (Telegram / WhatsApp / iMessage)
keep their single-thread-per-channel model and are unaffected. The
`conversations/` markdown archive that gbrain ingests stays intact; the
periodic checkpoint subsystem goes away.

## UI direction (locked: Layout C)

One sidebar. All agents listed as collapsible tree headers, each with their
own session list under it. Active agent flagged with a pill; active session
highlighted under its agent group. New-session button per agent header.

Mockup: `mockups/C-grouped-by-agent.html`. PWA: hamburger drawer on narrow
viewport, non-active agents auto-collapse, `100dvh` + safe-area-inset on
composer.

Rejected: A (one-agent-at-a-time dropdown — slow cross-agent scan),
B (Discord-style three-pane — too many panels for PWA, drill-down nav stack
adds taps on mobile).

## Data model

### Composite `chat_jid`

```
old:  web:<folder>
new:  web:<folder>:<sessionId>
```

`sessionId` is a UUID v4, nanoclaw-side identity. Distinct from the SDK's
internal session id. The composite jid wins us free auto-partitioning on
every existing key-on-chat_jid path:

- `messages` PK `(id, chat_jid)`
- `getMessagesByJid(chatJid)` — scopes prompt history to the session
- `lastAgentTimestamp[chat_jid]` — per-session high-water mark
- `webBroker` channel `out:<jid>` — SSE auto-scopes
- `processMessage` `<messages>` prompt block — auto-scopes

### New table

```sql
CREATE TABLE web_sessions (
  id              TEXT PRIMARY KEY,            -- nc-side uuid v4
  folder          TEXT NOT NULL,
  title           TEXT,                        -- null until first reply
  sdk_session_id  TEXT,                        -- SDK's session id; null pre-first-run
  created_at      TEXT NOT NULL,
  last_message_at TEXT,
  pinned          INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_web_sessions_folder
  ON web_sessions(folder, last_message_at DESC);
```

Helpers in `src/db.ts`:
`createWebSession`, `listWebSessions(folder)`, `getWebSession(id)`,
`renameWebSession`, `pinWebSession`, `archiveWebSession`, `deleteWebSession`,
`touchWebSession(id, ts)`, `setWebSessionSdkId(id, sdkId)`.

### `sessions` map rekey

`src/types.ts`:

```ts
// before
export interface Session {
  [folder: string]: string;
}
// after
export interface Session {
  [chatJid: string]: string;
}
```

IM channels stay one entry per channel (one jid). Web gets many entries
(one per session). On-disk `~/.nanoclaw/data/sessions.json` migrates in
process at boot: web entries become `web:<folder>:legacy`; IM unchanged;
sentinel `__migrated_v2: true` blocks re-runs.

### Agent registry

`registerWebAgent(folder, sessionId)` registers `web:<folder>:<sessionId>`
the first time it's pinged. `WebChannel.ownsJid` matches anything that
starts with `web:`. Lookup in `processMessage` stays exact-match on the
composite jid.

## Backend changes

| File                                   | Change                                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/db.ts`                            | New `web_sessions` schema + CRUD; legacy-row migration; helper `getMessagesByFolder` (joins `web:<folder>:*` + IM jids for folder).          |
| `src/types.ts`                         | `Session` keyed by `chat_jid`.                                                                                                               |
| `src/index.ts`                         | `sessions[…]` rekey; `registerWebAgent(folder, sessionId)`; `sessions.json` migrator; auto-title hook after first agent reply.               |
| `src/channels/web.ts`                  | `folderFromJid` / `sessionIdFromJid` helpers; ownership prefix match.                                                                        |
| `src/server/http.ts`                   | New session CRUD endpoints; existing `/chat`, `/chat/messages`, `/chat/stream`, `/chat/upload` require `sessionId`; drop `allChannels` flag. |
| `src/agent/runner.ts`                  | No code change — already resumes off whatever `sessions[chatJid]` resolves to.                                                               |
| `src/agent/ipc-mcp.ts`                 | No code change — jid is opaque to MCP.                                                                                                       |
| `src/agent/conversation-checkpoint.ts` | **Rewrite**: drop the per-session checkpoint subsystem; keep only the daily 1am job, rebuilt to read DB instead of `loadParsedTranscript`.   |

### HTTP endpoints

| Route                                   | Notes                                                          |
| --------------------------------------- | -------------------------------------------------------------- |
| `GET  /api/user/chat/sessions?folder=X` | List sessions (id, title, last_message_at, pinned, archived).  |
| `POST /api/user/chat/sessions`          | Body `{folder, title?}`. Inserts row, returns `{id, chatJid}`. |
| `PATCH /api/user/chat/sessions/:id`     | Rename / pin / archive.                                        |
| `DELETE /api/user/chat/sessions/:id`    | Soft delete: sets `archived=1`. Hard-delete behind admin flag. |
| `POST  /api/user/chat`                  | Now requires `sessionId`.                                      |
| `GET   /api/user/chat/messages`         | Now requires `folder` **and** `sessionId`.                     |
| `GET   /api/user/chat/stream`           | Now requires `folder` **and** `sessionId`.                     |
| `POST  /api/user/chat/upload`           | Now requires `sessionId`.                                      |

### Session creation flow

1. User clicks `＋ New session` under an agent header.
2. Client: `POST /api/user/chat/sessions {folder}` → `{id, chatJid}`.
3. Client: navigates to `/chat?session=<id>` (or pushes state). No DB
   activity yet beyond the row insert.
4. User types + sends: `POST /api/user/chat {folder, sessionId, text}` →
   ingest → processMessage → runner.
5. SDK emits `session.init.session_id` → store on `web_sessions.sdk_session_id`.
6. After agent's first reply, `processMessage` sets `web_sessions.title`
   to `trimLabel(firstUserPrompt, 60)` if still null.

## Checkpoint removal

### Today

Two parallel write paths:

- `checkpoints/<sdkSessionId>.md` — full transcript per session, rewritten
  every `MEMORY_FLUSH_INTERVAL` and on `/new`.
- `conversations/<date>.md` — produced by 1am cron from those checkpoints.

`buildWarmStartContext()` reads both, tail-caps, injects as `SessionStart`
hook context. gbrain's sync cron (`~/.gbrain/.cron/sync.sh`) git-commits
`conversations/` and runs `gbrain sync --all`, feeding the brain.

### After

- Periodic checkpoint, `flushBeforeSessionClear`, atomic-rename dance:
  **deleted**.
- Daily 1am consolidator: **rewritten** to source from DB. Same output
  path, same git-commit cron, same gbrain ingestion. Format:

  ```ts
  function buildDailyArchive(folder: string, date: string): string {
    const rows = getMessagesInRange(
      jidsForFolder(folder),
      `${date}T00:00:00`,
      `${date}T23:59:59`,
    );
    return rows
      .map((m) => {
        const who = m.is_from_me ? 'Assistant' : m.sender_name;
        return `**${who}** [${m.timestamp}]\n\n${m.content}`;
      })
      .join('\n\n---\n\n');
  }
  ```

- `buildWarmStartContext`: **rewrite** to query DB directly. Reads recent
  N days of messages for the folder, tail-cap at `WARM_START_BUDGET_BYTES`,
  same hook injection.

### Why this works

`ParsedMessage` already drops tool calls and thinking blocks during parse,
so today's `conversations/<date>.md` ≈ what's in the DB (minus row ids
and timestamps). DB rendering produces equivalent or better embed quality.
SDK JSONLs remain on disk for in-session resume and for the read-only
`/admin/transcripts` viewer — unaffected.

## gbrain impact

### Contract preserved

`var/agents/<folder>/conversations/<date>.md` keeps being written daily,
git-committed by the 15-min sync cron, ingested by `gbrain sync --all`.
File boundary preserved; only the file's source moves from filesystem
(checkpoints) to DB.

### Direct DB ingestion: rejected

Considered: have gbrain `sqlite3` `messages.db` directly via an
integrations recipe. Rejected because:

- Violates the "coupling = mcp.json only" boundary (reverse direction).
- Schema changes silently break gbrain ingestion.
- Either fragments brain (one page per message) or replicates the digest
  step on the wrong side of the boundary.
- Loses git-snapshot provenance of what was ingested when.

### MCP spawn frequency

Each SDK session spawns a fresh stdio gbrain MCP. One SDK session per
folder today → one spawn per folder. After: one SDK session per web
session → many spawns per day per folder. Each opens
`~/.gbrain/brain.pglite`. PGLite handles concurrent readers; cost is
startup latency.

Mitigation deferred until measured. If problematic: flip mcp.json entry
to `type: "http"` against a long-running `gbrain serve` socket. Skill
already supports it.

### Mutation denylist

Unchanged. `runner.ts`'s `disallowedTools` already covers all gbrain
mutating ops; each new SDK session inherits the same list.

## Migration

One-shot in `initDatabase`:

```sql
-- Tag pre-session web rows so they fall into a "legacy" session.
UPDATE messages
SET chat_jid = chat_jid || ':legacy'
WHERE chat_jid LIKE 'web:%' AND chat_jid NOT LIKE 'web:%:%';

-- Materialize one "legacy" session row per folder for the imported history.
INSERT OR IGNORE INTO web_sessions
  (id, folder, title, created_at, last_message_at, pinned)
SELECT
  'legacy',
  substr(chat_jid, 5, length(chat_jid) - 11),
  'Imported history',
  MIN(timestamp), MAX(timestamp), 0
FROM messages
WHERE chat_jid LIKE 'web:%:legacy'
GROUP BY chat_jid;
```

`sessions.json`: rekey at boot, write sentinel. Idempotent.

Old `checkpoints/` and `conversations/` dirs: stay on disk as historical
record, no longer read.

## Ordering

1. `db.ts` — `web_sessions` schema + CRUD + migration SQL.
2. `types.ts` + `index.ts` — `Session` rekey + `sessions.json` migrator +
   `registerWebAgent(folder, sessionId)` signature.
3. `web.ts` — `folderFromJid`, `sessionIdFromJid`, ownership match.
4. `http.ts` — session CRUD endpoints + updated chat / messages / stream /
   upload endpoints.
5. `processMessage` — auto-title hook + `touchWebSession` on each
   inbound/outbound.
6. `conversation-checkpoint.ts` — strip checkpoint paths, keep + rewrite
   daily consolidator to DB-source.
7. `runner.ts` — rewrite `buildWarmStartContext` to DB.
8. Frontend (separate PR) — sidebar tree UI, session CRUD calls, session-
   scoped chat view.

## Open questions

Defaults baked in unless redirected:

1. **Session id format** — UUID v4. Bulletproof, ugly URLs.
2. **Empty-session lifecycle** — row created on first user message, not on
   `＋ New` click. Avoids dangling drafts. `＋ New` clears the composer and
   sets a synthetic "draft" state until first send commits.
3. **Stale `sdk_session_id`** — if SDK has pruned the JSONL, `resume:`
   fails. Fallback: start a fresh SDK session, overwrite `sdk_session_id`,
   accept loss of in-session SDK-internal memory. DB warm-start re-injects
   conversational context. Documented behavior, no user-facing prompt.
4. **Serialization scope** — `folderQueues` stays per-folder. One agent
   identity = one concurrent runner. Multi-tab user sees turns serialize
   across their tabs.
5. **Cross-session messaging via IPC MCP** — agent can target any
   registered jid via `mcp__nanoclaw__send_message`. Sessions don't change
   this — power feature, not blocked. The agent receives its own
   `chatJid` in IPC context, so the default reply target stays the
   current session.
6. **gbrain MCP spawn cost** — defer until measured. If problematic,
   swap to persistent `gbrain serve` over HTTP/socket.

## Out of scope

- Project / workspace abstraction (Claude's "Projects"): sessions grouped
  under a project, with shared context. Future.
- Per-session memory isolation: warm-start currently injects folder-wide
  history. A session-isolated mode would gate the warm-start hook off.
  One-line change if needed later.
- LLM-summarized session titles: V1 is `trimLabel(firstPrompt, 60)`.
- Search across sessions: not in this PR. Sidebar search input is local
  client-side filter until needed.
