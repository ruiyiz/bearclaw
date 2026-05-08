# NanoClaw Specification

A personal Claude assistant accessible via chat platforms (WhatsApp, Telegram, iMessage) and Gmail, with persistent per-agent state, scheduled and event-driven handlers, and shared context. Long-term memory is delegated to a separate **gbrain** process exposed over MCP.

This document describes design and architecture decisions. Not a code reference; for that, follow the source from `src/index.ts`.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Folder Structure](#folder-structure)
3. [Configuration](#configuration)
4. [Memory System](#memory-system)
5. [Daily Conversation Flush](#daily-conversation-flush)
6. [Session Management](#session-management)
7. [Message Flow](#message-flow)
8. [Handlers (Scheduled + Event-Driven)](#handlers-scheduled--event-driven)
9. [MCP Servers](#mcp-servers)
10. [Deployment](#deployment)
11. [Security Considerations](#security-considerations)

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                          HOST (macOS)                              │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐        │
│  │ WhatsApp │  │ Telegram │  │ iMessage │  │ Gmail (poll) │        │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘        │
│       └─────────────┴─────────────┘               │                │
│                     │                             ▼                │
│              ┌──────▼──────┐                ┌─────────────┐        │
│              │   Router    │                │  Event Bus  │        │
│              └──────┬──────┘                └──────┬──────┘        │
│                     │                              │               │
│                     ▼                              ▼               │
│              ┌────────────────────────────────────────────┐        │
│              │           Agent Runner (in-process)        │        │
│              │   query() → Claude Agent SDK               │        │
│              │   tools: Bash, Read/Write/Edit, Web*,      │        │
│              │          mcp__nanoclaw__*, mcp__gbrain__*  │        │
│              │   gbrain mutating tools blocked at         │        │
│              │   SDK boundary (disallowedTools)           │        │
│              └────────────────────────────────────────────┘        │
│                                                                    │
│              ┌────────────────────────────────────────────┐        │
│              │       Conversation Checkpoint              │        │
│              │  every MEMORY_FLUSH_INTERVAL: full         │        │
│              │  transcript → checkpoints/{sessionId}.md   │        │
│              └────────────────────────────────────────────┘        │
│                                                                    │
│              ┌────────────────────────────────────────────┐        │
│              │       Daily Conversation Flush (01:00)     │        │
│              │  consolidate yesterday's checkpoints →     │        │
│              │  conversations/{date}.md per agent         │        │
│              └────────────────────────────────────────────┘        │
│                                                                    │
│              ┌────────────────────────────────────────────┐        │
│              │              IPC Watcher (file-based)      │        │
│              │   reads ~/.nanoclaw/var/run/ipc/{folder}/  │        │
│              └────────────────────────────────────────────┘        │
│                                                                    │
│              ┌────────────────────────────────────────────┐        │
│              │         SQLite (~/.nanoclaw/var/)          │        │
│              │   chats, messages, events, handlers,       │        │
│              │   handler_logs                             │        │
│              └────────────────────────────────────────────┘        │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘

       (separate process, separate launchd plists)

┌────────────────────────────────────────────────────────────────────┐
│   gbrain (~/.bun/bin/gbrain)                                       │
│   - stdio MCP, spawned per agent session                           │
│   - PGLite store at ~/.gbrain/brain.pglite                         │
│   - sources: main, coco (synced from conversation archives)        │
│   - cron: sync (15m), dream-cycle (02:00), doctor (Mon 06:00)      │
└────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology                            | Purpose                                |
| --------- | ------------------------------------- | -------------------------------------- |
| WhatsApp  | `@whiskeysockets/baileys`             | WhatsApp Web protocol                  |
| Telegram  | `grammy`                              | Bot API + agent-swarm bot pool         |
| iMessage  | `imsg` CLI + file tail                | macOS Messages                         |
| Email     | `gog` CLI                             | Gmail polling and sending              |
| Storage   | `better-sqlite3`                      | Messages, handlers, event bus          |
| Long-term | gbrain (PGLite + pgvector + tsvector) | Out-of-process knowledge base over MCP |
| Agent     | `@anthropic-ai/claude-agent-sdk`      | In-process Claude execution            |
| TUI       | `ink` + `react`                       | Status terminal UI                     |
| Runtime   | Node.js 20+                           | Single host process                    |

NanoClaw never imports gbrain code. The boundary is a single MCP entry in `~/.nanoclaw/config/mcp.json`. Drop the entry and the agent still boots, falling back to the warm-start window.

---

## Folder Structure

NanoClaw separates source repo, runtime config (`~/.nanoclaw/config/`), and runtime state (`~/.nanoclaw/var/`). Stable user content lives at the top level (`agents/`, `context/`, `skills/`); volatile state is namespaced under `var/`. gbrain owns its own home at `~/.gbrain/`.

```
~/.nanoclaw/
├── .env                              # Auth tokens, integration keys
├── config/                           # Stable, user-edited
│   ├── registered_agents.json
│   ├── mcp.json                      # gbrain stdio MCP entry + user-added MCPs
│   └── ...
├── context/                          # Stable shared context
│   ├── AGENTS.md                     # Operating manual (manual)
│   ├── CONTEXT.md                    # Cross-agent domain knowledge (manual)
│   ├── USER.md                       # Facts about the user (manual)
│   └── SOUL.md                       # Persona (manual)
├── agents/
│   └── {folder}/
│       └── IDENTITY.md               # Per-agent role/personality (manual)
├── skills/                           # User-installed skills
└── var/                              # Volatile runtime state
    ├── messages.db                   # SQLite (chats, messages, events, handlers)
    ├── sessions.json                 # Active session IDs per agent folder
    ├── auth/                         # Channel credentials
    ├── run/ipc/{folder}/             # IPC inbox per agent
    ├── backups/                      # pre-cutover tarballs etc.
    └── agents/{folder}/              # Per-agent volatile state
        ├── conversations/{date}.md   # One file per day per agent (daily flush)
        ├── checkpoints/{sessionId}.md   # Live transcript checkpoints
        └── logs/agent-*.log

~/.gbrain/                            # gbrain process home
├── config.json                       # database_path
├── brain.pglite/                     # PGLite store
├── .cron/                            # wrapper scripts (sync, dream-cycle, doctor)
└── .logs/                            # cron run logs
```

`agents/{folder}/` (stable, user-meaningful) vs `var/agents/{folder}/` (volatile, system-meaningful) is deliberate: `agents/` is what the user backs up, edits, or manually inspects; `var/` is what NanoClaw owns and may rewrite.

---

## Configuration

`src/config.ts` is the single source of truth for env vars, paths, and intervals. `~/.nanoclaw/.env` is loaded at startup.

### Authentication

```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...   # Subscription, OR
ANTHROPIC_API_KEY=sk-ant-api03-...         # Pay-per-use
OPENAI_API_KEY=sk-...                      # image_generate + gbrain embeddings
```

### Channels (optional)

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_POOL`, `IMESSAGE_ENABLED=true`, `ELEVENLABS_API_KEY` (TTS).

### Trigger word

`ASSISTANT_NAME` (default `Andy`) is both the trigger pattern (`@Andy …`) and the outbound prefix in group chats.

### Memory tunables

`WARM_START_DAYS` (default `2`), `WARM_START_BUDGET_BYTES` (default `16384`), `MEMORY_FLUSH_INTERVAL` (default 10 min).

---

## Memory System

NanoClaw's memory layers are designed around two principles:

1. **Files are authoritative; the database is auxiliary.** Conversations and context files live as markdown on disk. SQLite carries channel state, event bus, and handler bookkeeping — no curated content.
2. **In-process layers stay simple; long-term memory lives elsewhere.** NanoClaw owns checkpoints + daily conversations + manual context files. Anything richer (semantic search, timeline reasoning, cross-conversation graph) is delegated to gbrain over MCP. NanoClaw works without gbrain — falls back to the warm-start window.

| Layer                  | Location                                         | Owner            | Purpose                                         |
| ---------------------- | ------------------------------------------------ | ---------------- | ----------------------------------------------- |
| **Operating manual**   | `context/AGENTS.md`                              | User (manual)    | Behavior rules, tool conventions                |
| **Persona**            | `context/SOUL.md`                                | User (manual)    | Voice, style, character                         |
| **User profile**       | `context/USER.md`                                | User (manual)    | Durable facts about the user                    |
| **Domain knowledge**   | `context/CONTEXT.md`                             | User (manual)    | Lasting world / project / domain knowledge      |
| **Per-agent identity** | `agents/{folder}/IDENTITY.md`                    | User (manual)    | Per-agent role / personality                    |
| **Conversations**      | `var/agents/{folder}/conversations/{date}.md`    | Daily flush      | One file per day per agent (full-fidelity)      |
| **Checkpoints**        | `var/agents/{folder}/checkpoints/{sessionId}.md` | Periodic flusher | Crash-safety: live in-flight transcript         |
| **Long-term memory**   | gbrain (out-of-process)                          | gbrain sync cron | Hybrid keyword+vector recall over conversations |

### Conversation checkpoint

Every `MEMORY_FLUSH_INTERVAL` ticks (default 10 min), the full transcript of every live session is rewritten to `checkpoints/{sessionId}.md`. The checkpoint is a single file per session, overwritten each tick, not appended. Crash-safety material — bounded data loss is the tick interval.

### Warm-start context

When a new session starts, the agent's SessionStart hook injects, in this order, up to `WARM_START_BUDGET_BYTES` (default 16 KB):

1. Today's checkpoint (if a session crashed earlier today).
2. Last `WARM_START_DAYS` (default 2) of conversation archives, oldest → newest.

Cross-session shared context (AGENTS.md, SOUL.md, USER.md, IDENTITY.md) is appended to the system prompt — separate path, not part of the warm-start budget.

### Long-term memory (gbrain)

For anything older than the warm-start window, the agent calls `mcp__gbrain__query`, `mcp__gbrain__get_page`, `mcp__gbrain__traverse_graph`, etc. gbrain runs as a separate stdio MCP process spawned by the SDK per session. Its store is at `~/.gbrain/brain.pglite`; the brain is populated by a 15-minute cron that snapshots `var/agents/*/conversations/` into a git repo, runs `gbrain sync --all`, then `gbrain embed --stale`.

The agent only sees gbrain's read-only operations. Mutating tools (`put_page`, `delete_page`, `add_link`, `sync_brain`, …) are blocked at the SDK boundary via `disallowedTools` in `src/agent/runner.ts`. The CLI / cron jobs retain full access.

### Multi-agent boundaries

| Action                               | `main`     | Non-main   |
| ------------------------------------ | ---------- | ---------- |
| Read own conversations + checkpoints | yes        | yes        |
| Read other agents' conversations     | via gbrain | via gbrain |
| `register_agent`, IPC fan-out        | yes        | no         |

Manual context files in `~/.nanoclaw/context/` are visible to every agent. Per-agent identity is isolated to `agents/{folder}/IDENTITY.md`.

---

## Daily Conversation Flush

A single in-process timer fires at **01:00 local** (configurable via TIMEZONE). For each agent it consolidates every checkpoint older than today (by mtime) into `conversations/{date}.md`, appending if the file already exists, then deletes the consumed checkpoints. Live sessions are skipped — their checkpoint waits until the next 01:00 boundary.

```
checkpoints/abc123.md  (mtime 2026-05-08 11:42)  ┐
checkpoints/def456.md  (mtime 2026-05-08 19:03)  ├─→ conversations/2026-05-08.md
checkpoints/ghi789.md  (mtime 2026-05-08 23:55)  ┘
checkpoints/jkl012.md  (live session, mtime 2026-05-09 00:14)  → skipped
```

A startup sweep also runs the consolidator, so a crash that left checkpoints behind from a prior day is cleaned up immediately rather than waiting up to 24 hours.

`/new` writes a final checkpoint of the cleared session and drops the session id. It does **not** archive to `conversations/`. The daily flush is the only writer of `conversations/`.

---

## Session Management

Each agent maintains a Claude Agent SDK session. `var/sessions.json` maps agent folder → session id. The session is passed to `query()` via `resume`. The transcript itself lives at `~/.claude/projects/{encodedCwd}/{sessionId}.jsonl`.

### Resets

Sessions are cleared on `/new`. There is no daily session reset. Long-running sessions stay live across the daily flush boundary; only their checkpoints get consumed once the day rolls over.

The conversation checkpoint provides crash safety; the daily flush prevents `checkpoints/` from accumulating stale files. Manual `/new` is the only operator-driven reset.

---

## Message Flow

```
1. Channel adapter normalizes incoming message → SQLite + onMessage callback.
2. Per-agent queue serializes message handling; trigger pattern enforced for non-main.
3. processMessage builds a <messages> XML prompt from messages since lastAgentTimestamp.
4. agent/runner.ts invokes query():
     cwd: var/agents/{folder}/
     resume: sessionId
     systemPrompt: claude_code preset + context/{AGENTS,CONTEXT,SOUL,USER}.md
                 + IDENTITY.md + SYSTEM_PROMPT
     mcpServers: { nanoclaw: ipcMcp, ...userMcpServers }   # gbrain in userMcpServers
     SessionStart hook: warm-start budget (today's checkpoint + last N days)
5. The agent streams output. MCP-side effects (send_message, schedule_task, …) are
   written to var/run/ipc/{folder}/ and dispatched by the IPC watcher.
6. Final assistant text is sent to the channel.
7. lastAgentTimestamp is updated.
```

A recovery sweep runs every poll interval to catch messages missed during channel disconnects.

---

## Handlers (Scheduled + Event-Driven)

A unified `handlers` table stores both cron-scheduled and event-driven runs.

| Shape        | Storage                                       | Trigger                                               |
| ------------ | --------------------------------------------- | ----------------------------------------------------- |
| Cron         | `cron` field set                              | scheduler emits `cron_trigger` when `next_run <= now` |
| One-shot     | `next_run` set, `cron` null, `max_triggers=1` | same as cron                                          |
| Event-driven | `event_type != 'cron_trigger'`, `filter` JSON | event bus matches event type + filter                 |

### Built-in handler families

- **`heartbeat-{folder}`** — proactive wake-up loop per agent; configurable interval and quiet window.
- **`email-{folder}`** — per-agent Gmail polling; emits `email_received`.

Custom handlers are registered by agents via `register_handler` (event-driven) or `schedule_task` (cron / one-shot). Every handler completion emits `handler_complete`, which can drive subsequent handlers.

The earlier `dream-{folder}` and `dream-cycle-report` handler families are gone; gbrain owns long-term consolidation now and runs its own crons (separate launchd plists, not via NanoClaw's handler table).

---

## MCP Servers

### `nanoclaw` MCP (built-in)

Per-call MCP server with the agent's identity. Tools:

| Tool                                                                 | Purpose                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------ |
| `send_message`                                                       | Outbound channel message (text and/or media)           |
| `schedule_task`, `register_handler`                                  | Register handlers                                      |
| `list_handlers`, `pause_handler`, `resume_handler`, `cancel_handler` | Handler management                                     |
| `emit_event`                                                         | Custom event emission                                  |
| `register_agent`                                                     | Register a new chat as an agent (main only)            |
| `reply_email`                                                        | Thread a Gmail reply                                   |
| `subprocess_*`                                                       | PTY subprocess driver                                  |
| `image_generate`                                                     | OpenAI gpt-image / Google nano-banana image generation |

The previous `memory_search` / `memory_write` tools are removed. The agent uses gbrain MCP for retrieval.

### `gbrain` MCP (external, configured in `~/.nanoclaw/config/mcp.json`)

stdio entry: `command: /Users/<user>/.bun/bin/gbrain`, `args: ["serve"]`. Spawned by the SDK per session. Exposes the full gbrain operations set; mutating ops are denied at NanoClaw's `disallowedTools` boundary, so only read tools (`query`, `get_page`, `list_pages`, `traverse_graph`, `get_timeline`, `get_stats`, …) reach the model.

HTTP MCP exists in gbrain (`gbrain serve --http`) but the OAuth setup is Postgres-only on PGLite engines, so the persistent HTTP option is currently deferred. Each session pays a stdio cold-start (~50–200 ms) but otherwise the agent sees the full gbrain feature set.

### User MCP servers

`~/.nanoclaw/config/mcp.json` is merged into every agent's `mcpServers` config. Users add Notion, GitHub, etc. there without editing source. The gbrain entry lives there too, by convention.

---

## Deployment

NanoClaw runs as a single macOS launchd service (`~/Library/LaunchAgents/com.nanoclaw.plist`). gbrain crons are separate launchd plists owned by NanoClaw setup but logically independent.

```
~/Library/LaunchAgents/
├── com.nanoclaw.plist                # main agent runner
├── com.nanoclaw.imsg-watcher.plist   # iMessage tail
├── com.nanoclaw.gbrain.sync.plist    # 15min: snapshot conversations → gbrain sync + embed
├── com.nanoclaw.gbrain.dream.plist   # daily 02:00: gbrain dream
└── com.nanoclaw.gbrain.doctor.plist  # weekly Mon 06:00: gbrain doctor
```

### Startup sequence

1. Initialize SQLite (creates tables; runs incremental migrations; drops legacy `memory_*` and `dream_*` tables on first boot post-cutover).
2. Load `sessions.json`, `registered_agents.json`.
3. Run startup checkpoint consolidation (handles crash residue).
4. Start the conversation checkpoint ticker.
5. Schedule the daily 01:00 conversation flush.
6. Initialize the subprocess manager.
7. Register heartbeat / email handlers from `registered_agents.json`.
8. Connect channels.
9. Start: scheduler, event bus, IPC watcher, message recovery loop, email poll loops.

### Service management

```bash
launchctl load   ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Same pattern for the gbrain plists.

---

## Security Considerations

See [SECURITY.md](SECURITY.md) for the full threat model. Highlights:

- **No OS-level isolation.** Agents have host filesystem and network access.
- **Per-agent `cwd`.** Each agent's working directory is its own `var/agents/{folder}/`.
- **IPC authorization.** The IPC watcher rejects cross-agent operations from non-main agents (sending to other chats, registering handlers for other agents, calling `register_agent` / `refresh_agents`).
- **Trigger gate.** Non-main agents only fire on messages matching their configured trigger.
- **gbrain is read-only at the agent boundary.** Mutating ops are denied via `disallowedTools` in `runner.ts`. The cron jobs and the operator's CLI retain full write access.
- **Manual context applies; no auto-write.** `~/.nanoclaw/context/` is never written by NanoClaw or by gbrain. The user holds the commit button — agents propose changes via chat, the user replies with instructions, the agent edits via Read/Edit.
- **Credentials.** Loaded from `~/.nanoclaw/.env` into `process.env`. Agents can read them via Bash; this is a known limitation of the in-process model.

```bash
chmod 700 ~/.nanoclaw/agents/
chmod 600 ~/.nanoclaw/.env
```
