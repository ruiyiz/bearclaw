# BearClaw Specification

A personal Claude assistant accessible via chat platforms (WhatsApp, Telegram, iMessage) and Gmail, with persistent per-agent state, scheduled and event-driven workflows, and shared context.

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
8. [Workflows](#workflows)
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
│              │          mcp__bearclaw__*, user MCPs       │        │
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
│              │   reads ~/.bearclaw/var/run/ipc/{folder}/  │        │
│              └────────────────────────────────────────────┘        │
│                                                                    │
│              ┌────────────────────────────────────────────┐        │
│              │         SQLite (~/.bearclaw/var/)          │        │
│              │   chats, messages, events, workflows,      │        │
│              │   runs, steps, waits, triggers             │        │
│              └────────────────────────────────────────────┘        │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology                       | Purpose                             |
| --------- | -------------------------------- | ----------------------------------- |
| WhatsApp  | `@whiskeysockets/baileys`        | WhatsApp Web protocol               |
| Telegram  | `grammy`                         | Bot API + agent-swarm bot pool      |
| iMessage  | `imsg` CLI + file tail           | macOS Messages                      |
| Email     | `gog` CLI                        | Gmail polling and sending           |
| Storage   | `better-sqlite3`                 | Messages, workflow state, event bus |
| Agent     | `@anthropic-ai/claude-agent-sdk` | In-process Claude execution         |
| TUI       | `ink` + `react`                  | Status terminal UI                  |
| Runtime   | Node.js 20+                      | Single host process                 |

---

## Folder Structure

BearClaw separates source repo, runtime config (`~/.bearclaw/config/`), and runtime state (`~/.bearclaw/var/`). Stable user content lives at the top level (`agents/`, `context/`, `skills/`); volatile state is namespaced under `var/`.

```
~/.bearclaw/
├── .env                              # Auth tokens, integration keys
├── config/                           # Stable, user-edited
│   ├── registered_agents.json
│   ├── mcp.json                      # user-added MCP servers
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
    ├── messages.db                   # SQLite (chats, messages, events, workflow state)
    ├── sessions.json                 # Active session IDs per agent folder
    ├── auth/                         # Channel credentials
    ├── run/ipc/{folder}/             # IPC inbox per agent
    ├── backups/                      # pre-cutover tarballs etc.
    └── agents/{folder}/              # Per-agent volatile state
        ├── conversations/{date}.md   # One file per day per agent (daily flush)
        ├── checkpoints/{sessionId}.md   # Live transcript checkpoints
        └── logs/agent-*.log
```

`agents/{folder}/` (stable, user-meaningful) vs `var/agents/{folder}/` (volatile, system-meaningful) is deliberate: `agents/` is what the user backs up, edits, or manually inspects; `var/` is what BearClaw owns and may rewrite.

---

## Configuration

`src/config.ts` is the single source of truth for env vars, paths, and intervals. `~/.bearclaw/.env` is loaded at startup.

### Authentication

```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...   # Subscription, OR
ANTHROPIC_API_KEY=sk-ant-api03-...         # Pay-per-use
OPENAI_API_KEY=sk-...                      # image_generate
```

### Channels (optional)

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_POOL`, `IMESSAGE_ENABLED=true`, `ELEVENLABS_API_KEY` (TTS).

### Trigger word

`ASSISTANT_NAME` (default `Andy`) is both the trigger pattern (`@Andy …`) and the outbound prefix in group chats.

### Memory tunables

`WARM_START_DAYS` (default `2`), `WARM_START_BUDGET_BYTES` (default `16384`), `MEMORY_FLUSH_INTERVAL` (default 10 min).

---

## Memory System

BearClaw's memory layers are designed around two principles:

1. **Files are authoritative; the database is auxiliary.** Conversations and context files live as markdown on disk. SQLite carries channel state, event bus, and workflow bookkeeping — no curated content.
2. **Every layer is a file the user can open.** Checkpoints, daily conversations and manual context files are the whole of memory; recall over them is keyword search, not a second system to keep in sync. Nothing curated lives outside `~/.bearclaw/`.

| Layer                  | Location                                         | Owner            | Purpose                                    |
| ---------------------- | ------------------------------------------------ | ---------------- | ------------------------------------------ |
| **Operating manual**   | `context/AGENTS.md`                              | User (manual)    | Behavior rules, tool conventions           |
| **Persona**            | `context/SOUL.md`                                | User (manual)    | Voice, style, character                    |
| **User profile**       | `context/USER.md`                                | User (manual)    | Durable facts about the user               |
| **Domain knowledge**   | `context/CONTEXT.md`                             | User (manual)    | Lasting world / project / domain knowledge |
| **Per-agent identity** | `agents/{folder}/IDENTITY.md`                    | User (manual)    | Per-agent role / personality               |
| **Conversations**      | `var/agents/{folder}/conversations/{date}.md`    | Daily flush      | One file per day per agent (full-fidelity) |
| **Checkpoints**        | `var/agents/{folder}/checkpoints/{sessionId}.md` | Periodic flusher | Crash-safety: live in-flight transcript    |
| **Recall**             | `mcp__bearclaw__recall_history`                  | SQLite FTS5      | BM25 search over this agent's archives     |

### Conversation checkpoint

Every `MEMORY_FLUSH_INTERVAL` ticks (default 10 min), the full transcript of every live session is rewritten to `checkpoints/{sessionId}.md`. The checkpoint is a single file per session, overwritten each tick, not appended. Crash-safety material — bounded data loss is the tick interval.

### Warm-start context

When a new session starts, the agent's SessionStart hook injects, in this order, up to `WARM_START_BUDGET_BYTES` (default 16 KB):

1. Today's checkpoint (if a session crashed earlier today).
2. Last `WARM_START_DAYS` (default 2) of conversation archives, oldest → newest.

Cross-session shared context (AGENTS.md, SOUL.md, USER.md, IDENTITY.md) is appended to the system prompt — separate path, not part of the warm-start budget.

### Recall beyond the warm-start window

For anything older, the agent calls `mcp__bearclaw__recall_history`: FTS5 with BM25 ranking over its own `conversations/*.md` and `checkpoints/*.md`. Chunks are indexed lazily and reindexed on first call after a file changes, so there is no sync job to fall behind. Results carry file path and line range, so the agent can Read for more context.

### Multi-agent boundaries

| Action                               | `main` | Non-main |
| ------------------------------------ | ------ | -------- |
| Read own conversations + checkpoints | yes    | yes      |
| Read other agents' conversations     | no     | no       |
| `register_agent`, IPC fan-out        | yes    | no       |

Manual context files in `~/.bearclaw/context/` are visible to every agent. Per-agent identity is isolated to `agents/{folder}/IDENTITY.md`.

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
     mcpServers: { bearclaw: ipcMcp, ...userMcpServers }
     SessionStart hook: warm-start budget (today's checkpoint + last N days)
5. The agent streams output. Channel side effects (send_message, register_agent, …)
   are written to var/run/ipc/{folder}/ and dispatched by the IPC watcher; the
   workflow tools act on the engine directly.
6. Final assistant text is sent to the channel.
7. lastAgentTimestamp is updated.
```

A recovery sweep runs every poll interval to catch messages missed during channel disconnects.

---

## Workflows

A workflow is a definition file at `~/.bearclaw/workflows/<slug>.json`: a name, an
owner agent, an `inputs` schema, typed nodes, and edges leaving named ports. Node
types are `agent`, `shell`, `http`, `template`, `transform`, `condition`, `switch`,
`send`, `human`, `wait_event`, `emit` and `delay` — most of them are not LLM calls.
Files are the source of truth; SQLite holds the index, runs, steps, waits and
triggers.

A run copies the definition into its own row and executes against that snapshot.
The decider computes the nodes whose incoming edges are satisfied, runs them,
persists, and repeats; anything that changes a run re-runs the decider from
persisted state. Untaken branches never block a join. Retry precedence is the
node's retry policy, then a wired `error` port, then the workflow-level
`on_error`, then the run fails. Waits and delays are rows with `resume_at`;
nothing depends on a live timer surviving a restart.

### Triggers

A trigger is a separate row binding a firing condition to a workflow and supplying
its `args`, validated against the workflow's `inputs` schema.

| Type      | Fires when                                                         |
| --------- | ------------------------------------------------------------------ |
| `cron`    | `next_run_at` passes; honours a quiet window and a catch-up policy |
| `at`      | one-shot, then disables itself                                     |
| `event`   | a matching event lands on the bus                                  |
| `webhook` | `POST /api/hooks/<token>`                                          |
| `manual`  | dashboard button, `/workflows run <slug>`, or `workflow_run`       |

A definition file may declare triggers; the loader owns those rows and rewrites
them on every reload. Triggers created at runtime (a reminder for tomorrow, a
second schedule with different args) are rows with `source: runtime` and never
touch the file.

### Built-ins

- **`reminder`** — one shared workflow with a single `send` node; "remind me
  tomorrow at 9" is an `at` trigger on it with `args: { text, to }`.
- **`<folder>-checkin`** — what heartbeat used to be: a cron trigger with a quiet
  window and one `agent` node carrying the standing brief. There is no heartbeat
  concept in the engine.

Email polling still emits `email_received`; an event trigger subscribes to it.

---

## MCP Servers

### `bearclaw` MCP (built-in)

Per-call MCP server with the agent's identity. Tools:

| Tool                                               | Purpose                                                |
| -------------------------------------------------- | ------------------------------------------------------ |
| `send_message`                                     | Outbound channel message (text and/or media)           |
| `workflow_*`                                       | List, upsert, run, pause and inspect workflows         |
| `trigger_*`                                        | Create, list, pause and delete triggers                |
| `workflow_waits`, `workflow_respond`, `run_cancel` | Human steps and run control                            |
| `emit_event`                                       | Custom event emission (folder-prefixed for non-main)   |
| `register_agent`                                   | Register a new chat as an agent (main only)            |
| `reply_email`                                      | Thread a Gmail reply                                   |
| `subprocess_*`                                     | PTY subprocess driver                                  |
| `image_generate`                                   | OpenAI gpt-image / Google nano-banana image generation |

The previous `memory_search` / `memory_write` tools are removed. Retrieval goes through `recall_history`.

### User MCP servers

`~/.bearclaw/config/mcp.json` is merged into every agent's `mcpServers` config. Users add Notion, GitHub, etc. there without editing source.

---

## Deployment

BearClaw runs as a single macOS launchd service (`~/Library/LaunchAgents/com.bearclaw.plist`).

```
~/Library/LaunchAgents/
├── com.bearclaw.plist                # main agent runner
└── com.bearclaw.imsg-watcher.plist   # iMessage tail
```

### Startup sequence

1. Initialize SQLite (creates tables; runs incremental migrations; drops legacy `memory_*` and `dream_*` tables on first boot post-cutover).
2. Load `sessions.json`, `registered_agents.json`.
3. Run startup checkpoint consolidation (handles crash residue).
4. Start the conversation checkpoint ticker.
5. Schedule the daily 01:00 conversation flush.
6. Initialize the subprocess manager.
7. Start the workflow service: seed built-ins, migrate legacy handlers once, load definition files, recover interrupted runs.
8. Connect channels.
9. Start: workflow service loop, IPC watcher, message recovery loop, email poll loops.

### Service management

```bash
launchctl load   ~/Library/LaunchAgents/com.bearclaw.plist
launchctl unload ~/Library/LaunchAgents/com.bearclaw.plist
launchctl kickstart -k gui/$(id -u)/com.bearclaw
```

---

## Security Considerations

See [SECURITY.md](SECURITY.md) for the full threat model. Highlights:

- **No OS-level isolation.** Agents have host filesystem and network access.
- **Per-agent `cwd`.** Each agent's working directory is its own `var/agents/{folder}/`.
- **IPC authorization.** The IPC watcher rejects cross-agent operations from non-main agents (sending to other chats, managing workflows owned by other agents, calling `register_agent` / `refresh_agents`).
- **Trigger gate.** Non-main agents only fire on messages matching their configured trigger.
- **Manual context applies; no auto-write.** `~/.bearclaw/context/` is never written by BearClaw. The user holds the commit button — agents propose changes via chat, the user replies with instructions, the agent edits via Read/Edit.
- **Credentials.** Loaded from `~/.bearclaw/.env` into `process.env`. Agents can read them via Bash; this is a known limitation of the in-process model.

```bash
chmod 700 ~/.bearclaw/agents/
chmod 600 ~/.bearclaw/.env
```
