# BearClaw Specification

A personal Claude assistant accessible via chat platforms (WhatsApp, Telegram, iMessage) and Gmail, with persistent per-agent state, scheduled and event-driven workflows, and shared context.

This document describes design and architecture decisions. Not a code reference; for that, follow the source from `src/index.ts` into `src/app.ts`.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Folder Structure](#folder-structure)
3. [Configuration](#configuration)
4. [Memory System](#memory-system)
5. [Daily Rollover](#daily-rollover)
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
│              │            Daily Rollover (01:00)          │        │
│              │  yesterday's messages →                    │        │
│              │  conversations/{date}.md per agent,        │        │
│              │  then reset folder-keyed sessions          │        │
│              └────────────────────────────────────────────┘        │
│                                                                    │
│              ┌────────────────────────────────────────────┐        │
│              │              IPC Watcher (file-based)      │        │
│              │   reads ~/.bearclaw/var/run/ipc/{folder}/  │        │
│              └────────────────────────────────────────────┘        │
│                                                                    │
│              ┌────────────────────────────────────────────┐        │
│              │        SQLite: var/messages.db             │        │
│              │   chats, messages, events, workflows,      │        │
│              │   runs, steps, waits, triggers             │        │
│              └────────────────────────────────────────────┘        │
│                                                                    │
│              ┌────────────────────────────────────────────┐        │
│              │      SQLite: ~/.bearclaw/bearclaw.db       │        │
│              │   settings, agents, context, skills,       │        │
│              │   workflow definitions, MCP, model catalog │        │
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
| Web UI    | Next.js 15 PWA (`web/`)          | Chat, workflows, inbox, admin       |
| Runtime   | Node.js 20+                      | Single host process                 |

---

## Folder Structure

BearClaw separates the source repo, the config database (`~/.bearclaw/bearclaw.db`), and runtime state (`~/.bearclaw/var/`). Everything stable that the user owns is a row: settings and secrets, the agent registry, context documents, skills, workflow definitions, MCP servers and the model catalog. Nothing under `var/` is user-authored.

```
~/.bearclaw/
├── bearclaw.db                       # Config database (mode 0600)
│     settings          key/value, secrets flagged; keys are env var names
│     agents            folder → name, channels, per-agent config
│     context_files     shared + per-agent markdown (AGENTS, CONTEXT, USER,
│                       SOUL, IDENTITY, workflow templates)
│     skills/skill_files/skill_sources
│     workflow_definitions, mcp_servers, model_catalog
└── var/                              # Volatile runtime state
    ├── messages.db                   # SQLite (chats, messages, events, workflow state)
    ├── sessions.json                 # Active session IDs per agent folder
    ├── auth-secret                   # HMAC key for web sessions
    ├── auth/                         # Channel credentials
    ├── run/ipc/{folder}/             # IPC inbox per agent
    ├── cache/                        # Read-only mirrors of DB rows
    │   ├── skills/{name}/            # What the SDK discovers
    │   └── context/                  # shared/ and agents/{folder}/
    └── agents/{folder}/              # Per-agent volatile state, and the agent's cwd
        ├── .claude/skills → ../../../cache/skills
        ├── context → ../../cache/context
        ├── conversations/{date}.md   # One file per day per agent (daily flush)
        └── logs/agent-*.log
```

The split is deliberate: rows are what the user backs up (`bearclaw export`) and edits (CLI or web admin); `var/` is what BearClaw owns and may rewrite. The mirrors exist because the Agent SDK loads skills and context from real files; a `PreToolUse` hook denies agent writes under `var/cache/`, so the only way to change a document is `context_write` or the admin API. `~/.bearclaw` is not a git repo, and there is no `.env`.

---

## Configuration

`src/index.ts` bootstraps before anything else is imported: it creates the `var/` layout, opens the config database, and copies every settings row into `process.env` without overwriting a variable already set there. Only then does it import `src/app.ts`. `src/config.ts` reads that environment once and is the single source of truth for paths and intervals, so a settings change takes effect on the next restart.

Setting keys are env var names, which is what makes the override work: the environment wins over the database, and the database wins over the code default. `bearclaw config list|get|set|unset` and Admin > Settings are the two ways in. `BEARCLAW_HOME`, `NODE_ENV`, `BEARCLAW_HTTP_PORT`, `BEARCLAW_HTTP_HOST` and `BEARCLAW_BACKEND_URL` stay environment-only: they are read before, or outside, the database.

### Authentication

```
CLAUDE_CODE_OAUTH_TOKEN   # Subscription, from `claude setup-token`, OR
ANTHROPIC_API_KEY         # Pay-per-use
OPENAI_API_KEY            # image_generate
```

Keys matching `TOKEN|KEY|PASSWORD|SECRET` are stored with the `secret` flag and
redacted by every listing route. The web password is the exception: it is kept
as an scrypt hash under the internal key `bearclaw.password_hash`, and internal
`bearclaw.*` keys are never exported to the environment.

### Channels (optional)

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_POOL`, `IMESSAGE_ENABLED=true`, `ELEVENLABS_API_KEY` (TTS).

### Trigger word

`ASSISTANT_NAME` (default `Andy`) is both the trigger pattern (`@Andy …`) and the outbound prefix in group chats.

### Memory tunables

`WARM_START_DAYS` (default `2`), `WARM_START_BUDGET_BYTES` (default `32768`).

---

## Memory System

BearClaw's memory layers are designed around two principles:

1. **One store per kind of state.** Conversation archives are markdown on disk under `var/`; context documents are rows in the config database, mirrored to files the SDK can read. `var/messages.db` carries channel state, the event bus and workflow bookkeeping.
2. **Every layer is something the user can open.** Daily conversations are files; context documents are one editor away in Admin > Context or one `bearclaw config` neighbour. Recall over the archives is keyword search, not a second system to keep in sync.

| Layer                  | Location                                      | Owner             | Purpose                                       |
| ---------------------- | --------------------------------------------- | ----------------- | --------------------------------------------- |
| **Operating manual**   | `context_files` row `AGENTS.md` (shared)      | User + agent      | Behavior rules, tool conventions              |
| **Persona**            | `context_files` row `SOUL.md` (shared)        | User + agent      | Voice, style, character                       |
| **User profile**       | `context_files` row `USER.md` (shared)        | User + agent      | Durable facts about the user                  |
| **Domain knowledge**   | `context_files` row `CONTEXT.md` (shared)     | User + agent      | Lasting world / project / domain knowledge    |
| **Per-agent identity** | `context_files` row `IDENTITY.md` ({folder})  | User + agent      | Per-agent role / personality                  |
| **Conversations**      | `var/agents/{folder}/conversations/{date}.md` | Daily flush       | One file per day per agent (full-fidelity)    |
| **Warm start**         | last `WARM_START_DAYS` of `var/messages.db`   | SessionStart hook | Recent cross-channel context on a new session |
| **Recall**             | `mcp__bearclaw__recall_history`               | SQLite FTS5       | BM25 search over this agent's archives        |

### Warm-start context

When a new session starts, the agent's SessionStart hook injects the last
`WARM_START_DAYS` (default 2) of this agent's messages, read back from
`var/messages.db` across every jid the folder owns (web sessions folded in),
tail-capped at `WARM_START_BUDGET_BYTES` (default 32 KB).

Cross-session shared context (AGENTS.md, SOUL.md, USER.md, IDENTITY.md) is
appended to the system prompt, a separate path that is not part of the
warm-start budget.

### Recall beyond the warm-start window

For anything older, the agent calls `mcp__bearclaw__recall_history`: FTS5 with BM25 ranking over its own `conversations/*.md` (plus any `checkpoints/*.md` left behind by earlier versions). Chunks are indexed lazily and reindexed on first call after a file changes, so there is no sync job to fall behind. Results carry file path and line range, so the agent can Read for more context.

### Multi-agent boundaries

| Action                           | `main` | Non-main |
| -------------------------------- | ------ | -------- |
| Read own conversation archives   | yes    | yes      |
| Read other agents' conversations | no     | no       |
| `register_agent`, IPC fan-out    | yes    | no       |

Shared context rows are visible to every agent. Per-agent identity is isolated to that folder's `IDENTITY.md` row. `context_write` enforces the same split: only the main agent may write a shared row or another folder's row.

---

## Daily Rollover

A single in-process timer fires at **01:00 local** (configurable via TIMEZONE) and does two things per agent folder.

1. **Flush.** Every message from yesterday, across each jid the folder owns plus its `web:{folder}:*` sessions, is read back from `var/messages.db` and written to `conversations/{date}.md`. The file is rewritten rather than appended, so replaying the flush is a no-op.
2. **Reset.** Folder-keyed IM and email sessions are marked to drain and their session ids dropped, so the next message opens a fresh session with warm-start re-injection. Web sessions are left alone; the UI owns those.

```
messages.db rows for 2026-05-08, folder `main`  ─→ var/agents/main/conversations/2026-05-08.md
```

A boot catch-up runs the flush only. The reset is deliberately not replayed on startup: it would close sessions opened since the last 01:00 boundary.

`/new` drops a session id on demand. The rollover is the only writer of `conversations/`.

---

## Session Management

Each agent maintains a Claude Agent SDK session. `var/sessions.json` maps agent folder → session id. The session is passed to `query()` via `resume`. The transcript itself lives at `~/.claude/projects/{encodedCwd}/{sessionId}.jsonl`.

### Resets

Sessions are cleared on `/new`, and folder-keyed sessions are also reset by the 01:00 rollover, which bounds how long one session's context can grow. Web sessions are exempt; users manage those from the UI.

---

## Message Flow

```
1. Channel adapter normalizes incoming message → SQLite + onMessage callback.
2. Per-agent queue serializes message handling; trigger pattern enforced for non-main.
3. processMessage builds a <messages> XML prompt from messages since lastAgentTimestamp.
4. agent/runner.ts invokes query():
     cwd: var/agents/{folder}/
     resume: sessionId
     systemPrompt: claude_code preset + shared {AGENTS,CONTEXT,SOUL,USER}.md rows
                 + the folder's IDENTITY.md row + SYSTEM_PROMPT
     mcpServers: { bearclaw: ipcMcp, ...userMcpServers }
     SessionStart hook: warm-start budget (last N days of this folder's messages)
5. The agent streams output. Channel side effects (send_message, register_agent, …)
   are written to var/run/ipc/{folder}/ and dispatched by the IPC watcher; the
   workflow tools act on the engine directly.
6. Final assistant text is sent to the channel.
7. lastAgentTimestamp is updated.
```

A recovery sweep runs every poll interval to catch messages missed during channel disconnects.

---

## Workflows

A workflow is a JSON definition in the config database (`workflow_definitions`,
keyed by slug): a name, an owner agent, an `inputs` schema, typed nodes, and edges
leaving named ports. Node types are `agent`, `shell`, `http`, `template`,
`transform`, `condition`, `switch`, `send`, `human`, `wait_event`, `emit` and
`delay`, most of them not LLM calls. The definition rows are the source of truth;
`var/messages.db` holds the index, runs, steps, waits and triggers. Definitions
move in and out as files through `bearclaw workflows export|import`, the web
detail page, or the `workflow_upsert` tool.

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

Enabled rows of the `mcp_servers` table are merged into every agent's `mcpServers` config, with `${VAR}` references expanded from the environment (so a token can stay a secret settings row). Users add Notion, GitHub, and the rest with `bearclaw config mcp set` or Admin > Settings, without editing source.

---

## Deployment

BearClaw runs as macOS launchd services. `bearclaw setup` renders them from the templates in `launchd/`, substituting the node path, the project root and the home directory, and starts them.

```
~/Library/LaunchAgents/
├── com.bearclaw.plist                # main process: channels, scheduler, HTTP API
├── com.bearclaw.web.plist            # Next.js web UI on :3030
└── com.bearclaw.imsg-watcher.plist   # iMessage tail (added by the iMessage setup script)
```

The plists carry only machine-local environment (`BEARCLAW_HOME` when it is not the default, `PATH`); everything else comes from the config database, so a plist can never shadow a setting.

### Startup sequence

1. Bootstrap (`src/index.ts`): create the `var/` layout, open `bearclaw.db`, run its migrations, copy settings into `process.env`, then import `src/app.ts`.
2. Initialize `var/messages.db` (creates tables; runs incremental migrations).
3. Load `sessions.json` and the agent registry from the config database; rebuild the `var/cache/` mirrors and the per-agent symlinks.
4. Run the boot catch-up flush (yesterday's archive, idempotent).
5. Schedule the 01:00 daily rollover (flush + session reset).
6. Initialize the subprocess manager.
7. Start the workflow service: seed built-ins, migrate legacy handlers once, load the definition rows, recover interrupted runs.
8. Connect channels. A channel that cannot start (a rejected Telegram token, say) is logged and skipped; the rest of the boot continues.
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
- **Context changes are explicit.** BearClaw never rewrites a context row on its own. An agent changes one only through `mcp__bearclaw__context_write`, which is scoped to its own folder unless it is main; the mirrors under `var/cache/` are read-only to the agent, enforced by a `PreToolUse` hook.
- **Credentials.** Settings rows are copied into `process.env` at boot, so agents can read them via Bash. This is a known limitation of the in-process model, unchanged by the move off `.env`.
- **Database permissions.** `bearclaw.db` is created mode 0600 and holds every secret in the clear except the web password, which is an scrypt hash. `bearclaw doctor` checks the mode.
- **Export bundles.** `bearclaw export` writes the config database and the channel credentials to a single `0600` tarball. Treat it like a password file.
