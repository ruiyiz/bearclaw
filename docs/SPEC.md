# NanoClaw Specification

A personal Claude assistant accessible via chat platforms (WhatsApp, Telegram, iMessage) and Gmail, with persistent memory per agent, scheduled handlers, event-driven handlers, and shared context.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Folder Structure](#folder-structure)
3. [Configuration](#configuration)
4. [Memory System](#memory-system)
5. [Session Management](#session-management)
6. [Message Flow](#message-flow)
7. [Handlers](#handlers-scheduled--event-driven)
8. [MCP Servers](#mcp-servers)
9. [Deployment](#deployment)
10. [Security Considerations](#security-considerations)
11. [Troubleshooting](#troubleshooting)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          HOST (macOS)                                │
│                     (Single Node.js Process)                         │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐   ┌─────────────┐          │
│  │ WhatsApp │  │ Telegram │  │ iMessage │   │ Gmail (poll)│          │
│  │ baileys  │  │ grammY   │  │ imsg cli │   │ gog cli     │          │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘   └─────┬───────┘          │
│       │             │             │               │                  │
│       └─────────────┴─────────────┘               │                  │
│                     │                             ▼                  │
│              ┌──────▼──────┐                ┌─────────────┐          │
│              │   Router    │                │  Event Bus  │          │
│              │ (per-agent  │                │ (handlers)  │          │
│              │   queue)    │                └──────┬──────┘          │
│              └──────┬──────┘                       │                 │
│                     │                              │                 │
│                     ▼                              ▼                 │
│              ┌──────────────────────────────────────────────┐        │
│              │           Agent Runner (in-process)          │        │
│              │   query() ─→ Claude Agent SDK                │        │
│              │   cwd: ~/.nanoclaw/agents/{folder}/          │        │
│              │   tools: Bash, Read/Write/Edit, Web*, MCP    │        │
│              │   mcpServers: { nanoclaw: ipcMcp, ... }      │        │
│              └──────────────────────────────────────────────┘        │
│                                                                      │
│              ┌──────────────────────────────────────────────┐        │
│              │              IPC Watcher (file-based)        │        │
│              │   reads ~/.nanoclaw/data/ipc/{folder}/       │        │
│              │   dispatches outbound messages, handler ops  │        │
│              └──────────────────────────────────────────────┘        │
│                                                                      │
│              ┌──────────────────────────────────────────────┐        │
│              │         SQLite (~/.nanoclaw/store/)          │        │
│              │   chats, messages, events, handlers,         │        │
│              │   handler_logs, memory_fts                   │        │
│              └──────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| WhatsApp | `@whiskeysockets/baileys` | WhatsApp Web protocol |
| Telegram | `grammy` | Bot API + agent-swarm bot pool |
| iMessage | `imsg` CLI + file tail | macOS Messages |
| Email | `gog` CLI | Gmail polling and sending |
| Storage | `better-sqlite3` | Messages, handlers, event bus, FTS |
| Agent | `@anthropic-ai/claude-agent-sdk` | In-process Claude execution |
| TUI | `ink` + `react` | Status terminal UI |
| Runtime | Node.js 20+ | Single host process |

---

## Folder Structure

```
nanoclaw/                            # Source repo
├── CLAUDE.md
├── README.md
├── package.json
├── tsconfig.json
│
├── docs/
│   ├── SPEC.md, REQUIREMENTS.md, SECURITY.md
│   └── plans/                       # Historical design plans
│
├── src/
│   ├── index.ts                     # Entry: channel wiring, router, IPC watcher
│   ├── config.ts                    # Env vars, paths, intervals
│   ├── types.ts                     # Shared TS types
│   ├── logger.ts, db.ts             # Trunk modules
│   ├── agent/                       # Claude Agent SDK runtime
│   │   ├── runner.ts                # query() invocation
│   │   ├── ipc-mcp.ts               # MCP tools the agent calls
│   │   ├── subprocess-manager.ts    # PTY subprocesses
│   │   ├── memory-flusher.ts        # Transcript → daily memory
│   │   └── system-prompt.ts
│   ├── channels/                    # User-facing surfaces
│   │   ├── whatsapp.ts, telegram.ts, imessage.ts
│   │   └── router.ts                # findChannel(channels, jid)
│   ├── events/
│   │   ├── bus.ts                   # Event dispatch + handler runner
│   │   ├── scheduler.ts             # Cron handler firing
│   │   └── heartbeat.ts             # Heartbeat handler config
│   ├── integrations/
│   │   └── email.ts                 # Gmail poll + reply
│   ├── media/
│   │   ├── format.ts                # Markdown renderers per channel
│   │   ├── source.ts                # Mime-type / media source resolution
│   │   ├── transcribe.ts, tts.ts    # Voice IO
│   ├── utils/
│   │   ├── json.ts, time.ts
│   ├── scripts/
│   │   └── whatsapp-auth.ts         # Standalone QR auth CLI
│   └── tui/                         # Status TUI
│
├── dist/                            # Compiled JS (gitignored)
├── .claude/skills/                  # Customization skills (SKILL.md per skill)
└── logs/                            # Runtime logs (gitignored)

~/.nanoclaw/                         # Runtime state (outside the repo)
├── .env                             # Auth tokens, channel tokens, integrations
├── context/
│   ├── AGENTS.md, SOUL.md, USER.md, MEMORY.md   # Shared across all agents
├── agents/
│   ├── main/
│   │   ├── IDENTITY.md              # Per-agent identity / role
│   │   ├── memory/YYYY-MM-DD.md     # Daily memory log
│   │   ├── conversations/           # Archived sessions
│   │   ├── logs/                    # agent-*.log per run
│   │   └── ...                      # Files the agent creates
│   └── {folder}/                    # One per registered agent
├── skills/                          # User-installed skills
├── store/
│   ├── auth/                        # WhatsApp Baileys auth
│   └── messages.db                  # SQLite (chats, messages, events, handlers, memory_fts)
├── data/
│   ├── sessions.json                # Active session IDs per agent folder
│   ├── registered_agents.json       # JID → agent mapping
│   ├── router_state.json            # Last processed timestamp + per-agent timestamps
│   ├── ipc/{folder}/                # Per-agent IPC: messages/, tasks/, current_handlers.json, ...
│   └── subprocesses/                # PTY subprocess state + output
└── bin/nanoclaw-notify              # Notify shim written by the subprocess manager
```

---

## Configuration

`src/config.ts` is the single source of truth for env vars, paths, and intervals. `dotenv` loads `~/.nanoclaw/.env` at startup.

Selected exports:

```typescript
ASSISTANT_NAME       // trigger word, default "Andy"
DISPLAY_NAME         // outbound prefix, defaults to ASSISTANT_NAME
TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_POOL, TELEGRAM_ONLY
IMESSAGE_ENABLED
NANOCLAW_HOME, STORE_DIR, CONTEXT_DIR, AGENTS_DIR, DATA_DIR
MAIN_AGENT_FOLDER = 'main'
AGENT_TIMEOUT             // default 300_000 ms
SESSION_RESET_HOUR        // default 4 (4 AM local)
SESSION_IDLE_MINUTES      // default -1 (disabled)
TIMEZONE                  // process.env.TZ or system default
TRIGGER_PATTERN           // RegExp ^@<ASSISTANT_NAME>\b
HEARTBEAT_HANDLER_PREFIX, HEARTBEAT_PROMPT
EMAIL_HANDLER_PREFIX, EMAIL_DEFAULT_INTERVAL
```

### Authentication

`~/.nanoclaw/.env` should contain one of:

```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...   # Subscription
ANTHROPIC_API_KEY=sk-ant-api03-...         # Pay-per-use
```

Channel tokens (optional): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_POOL`, `IMESSAGE_ENABLED=true`.

### Changing the Assistant Name

Set `ASSISTANT_NAME=Bot` in `~/.nanoclaw/.env`. This shifts both the trigger pattern (`@Bot ...`) and the outbound prefix (`Bot:`).

---

## Memory System

NanoClaw separates **shared context** from **per-agent identity** and **rolling memory**.

| Layer | Location | Read by | Written by | Purpose |
|------|----------|---------|------------|---------|
| **Shared context** | `~/.nanoclaw/context/{AGENTS,SOUL,USER,MEMORY}.md` | All agents | Main only (MEMORY) | Stable durable facts, persona, user info |
| **Identity** | `~/.nanoclaw/agents/{folder}/IDENTITY.md` | That agent | Hand-edited | Per-agent role/personality |
| **Daily log** | `~/.nanoclaw/agents/{folder}/memory/YYYY-MM-DD.md` | That agent (via `memory_search`) | `memory_write` MCP tool | Running notes, decisions, context |
| **Conversations** | `~/.nanoclaw/agents/{folder}/conversations/` | That agent | `memory-flusher.ts` on session end | Full archived transcripts |
| **Working files** | `~/.nanoclaw/agents/{folder}/...` | That agent | The agent (Bash/Write/Edit) | Notes, research, scratch |

**Context loading.** The agent runner concatenates the shared context files plus the agent's `IDENTITY.md` and appends them to the system prompt before invoking `query()`. The `SessionStart` hook also injects the last two days of `memory/*.md` so the agent boots with recent state.

**Memory search.** `memory_write` appends to today's daily log and indexes it into a SQLite FTS5 table. `memory_search` returns ranked snippets across `memory/` and `conversations/`.

**Main-agent privileges.** Only `main` writes to shared `context/MEMORY.md`. Other agents can only write to their own agent folder.

---

## Session Management

Each agent maintains a Claude Agent SDK session for conversation continuity.

`~/.nanoclaw/data/sessions.json`:
```json
{
  "main": "session-abc123",
  "family": "session-def456"
}
```

The session ID is passed to `query()` via the `resume` option. The corresponding transcript lives at `~/.claude/projects/{encodedCwd}/{sessionId}.jsonl`.

**Resets.** Sessions are cleared automatically:
- Daily, at `SESSION_RESET_HOUR` local time (default 4 AM, set to `-1` to disable)
- After `SESSION_IDLE_MINUTES` of inactivity (default `-1`, disabled)
- On `/new` from the user

Before a reset, `memory-flusher.ts` archives the transcript into `conversations/` and appends a session summary to today's `memory/YYYY-MM-DD.md`.

---

## Message Flow

```
1. User sends a message on a channel (WhatsApp / Telegram / iMessage)
   │
   ▼
2. Channel adapter normalizes it into a NewMessage and stores it in SQLite
   │
   ▼
3. Adapter's onMessage callback fires; index.ts dispatches via per-agent queue
   │
   ▼
4. processMessage(msg):
   ├── If chat is unregistered → drop
   ├── If non-main and trigger pattern doesn't match → drop
   ├── If activeHours configured and we're outside it → send off-hours auto-reply, drop
   ├── If content starts with /new → flush + clear session, then continue
   │
   ▼
5. Build a <messages> XML prompt from all messages since lastAgentTimestamp
   │
   ▼
6. agent/runner.ts → query():
   ├── cwd: ~/.nanoclaw/agents/{folder}/
   ├── resume: sessionId
   ├── systemPrompt: claude_code preset + shared context + IDENTITY.md + SYSTEM_PROMPT
   ├── allowedTools: Bash, Read/Write/Edit/Glob/Grep, Web*, Skill, mcp__*
   └── mcpServers: nanoclaw (IPC) + user MCP servers from ~/.nanoclaw/mcp.json
   │
   ▼
7. Agent streams output. If the channel supports edits (Telegram), live-edit a
   placeholder until the run completes.
   │
   ▼
8. The agent may call MCP tools (send_message, schedule_task, …) — these
   write JSON to ~/.nanoclaw/data/ipc/{folder}/. The IPC watcher picks them up.
   │
   ▼
9. Final assistant text is sent to the channel (with DISPLAY_NAME prefix
   where applicable). Voice messages are echoed as a transcript first and
   replied to with a TTS audio note when ELEVENLABS_API_KEY is set.
   │
   ▼
10. lastAgentTimestamp is updated and persisted in router_state.json.
```

A separate **recovery sweep** runs every `POLL_INTERVAL` (30 s) over SQLite to catch messages missed during channel disconnects.

---

## Handlers (Scheduled + Event-Driven)

A unified `handlers` table stores both cron-scheduled and event-driven runs.

### Schedule shapes

| Shape | Storage | Triggered by |
|-------|---------|--------------|
| Cron | `cron` field set | `events/scheduler.ts` emits `cron_trigger` when `next_run <= now` |
| One-shot | `next_run` set, `cron` null, `max_triggers=1` | Same as cron |
| Event-driven | `event_type != 'cron_trigger'`, `filter` JSON | `events/bus.ts` matches event type + filter |

### Lifecycle

1. **Register** — `register_handler` (event-driven), `schedule_task` (cron / one-shot), or built-in (heartbeat, email_received).
2. **Fire** — `events/bus.ts` runs the handler in a fresh agent invocation. Context mode is either `agent` (shared session, can use payload's `session_key`) or `isolated` (fresh session every time).
3. **Log** — duration, status, result/error written to `handler_logs`.
4. **Chain** — every handler completion emits `handler_complete`; agent runs emit `agent_complete`. These can drive subsequent handlers.

### Built-in event types

| Event | Source | Payload |
|-------|--------|---------|
| `cron_trigger` | `events/scheduler.ts` | `{ handler_id }` |
| `email_received` | `integrations/email.ts` | `{ group_folder, message_id, thread_id, from, subject, body, ... }` |
| `subprocess_exit` / `subprocess_notification` | `agent/subprocess-manager.ts` | `{ sessionId, exitCode, ... }` |
| `agent_complete` | `agent/runner.ts` | `{ group_folder, trigger_type, status, duration_ms }` |
| `handler_complete` | `events/bus.ts` | `{ handler_id, group_folder, status, result_summary }` |

Custom events can be emitted by agents via `mcp__nanoclaw__emit_event`.

### Heartbeat

When an agent has `heartbeat: { interval, model?, quiet? }` set in `registered_agents.json`, NanoClaw maintains a recurring `heartbeat-{folder}` handler that wakes the agent on the configured interval (skipped during the optional `quiet` window).

### Email

When an agent has `email: { address, interval? }`, a poll loop fetches unread Gmail to that address, emits `email_received`, and the matching handler runs the agent. The agent can call `reply_email` to thread a response.

---

## MCP Servers

### `nanoclaw` MCP (built-in, see `src/agent/ipc-mcp.ts`)

Created per-agent-call with the agent's identity. Tools:

| Tool | Purpose |
|------|---------|
| `send_message` | Outbound channel message (text and/or media) |
| `schedule_task` | Cron or one-shot handler |
| `register_handler` | Event-driven handler |
| `list_handlers`, `pause_handler`, `resume_handler`, `cancel_handler` | Handler management |
| `emit_event` | Custom event emission |
| `register_agent` | Register a new chat as an agent (main only) |
| `reply_email` | Thread a Gmail reply |
| `memory_write`, `memory_search` | Daily log + FTS lookup |
| `subprocess_start/read/write/poll/kill/list` | PTY subprocess driver |

### User MCP servers

`~/.nanoclaw/mcp.json` is merged into every agent's `mcpServers` config so users can add Notion, GitHub, etc. without editing source.

---

## Deployment

NanoClaw runs as a single macOS launchd service (`~/Library/LaunchAgents/com.nanoclaw.plist`).

### Startup sequence

1. Initialize SQLite (creating tables and running migrations: `groups → agents`, `event_handlers + scheduled_tasks → handlers`, `context_mode 'group' → 'agent'`).
2. Run the `groups/ → agents/` filesystem migration (one-shot, idempotent).
3. Load `router_state.json`, `sessions.json`, `registered_agents.json`.
4. Seed memory-flush cursors and start the memory flusher.
5. Initialize the subprocess manager and write the notify shim.
6. Register heartbeat and email handlers from `registered_agents.json`.
7. Connect channels (`WhatsApp` if not `TELEGRAM_ONLY`, `Telegram` if `TELEGRAM_BOT_TOKEN`, `iMessage` if `IMESSAGE_ENABLED=true`).
8. Start: session reset loop, scheduler, event bus, IPC watcher, message recovery loop, email loops.

### Service management

```bash
# Install
cp launchd/com.nanoclaw.plist ~/Library/LaunchAgents/

# Start / Stop / Restart
launchctl load   ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Status
launchctl list | grep nanoclaw

# Logs
tail -f logs/nanoclaw.log
```

---

## Security Considerations

See [SECURITY.md](SECURITY.md) for the full threat model. Highlights:

- **No OS-level isolation.** Agents have host filesystem and network access.
- **Per-agent `cwd`.** Each agent's working directory is its own `~/.nanoclaw/agents/{folder}/`.
- **IPC authorization.** The IPC watcher in `src/index.ts` rejects cross-agent operations from non-main agents (sending to other chats, registering handlers for other agents, calling `register_agent` / `refresh_agents`).
- **Trigger gate.** Non-main agents only fire on messages matching their configured trigger.
- **Credentials.** Loaded from `~/.nanoclaw/.env` into `process.env`. Agents can read them via Bash; this is a known limitation of the in-process model.

### File permissions

```bash
chmod 700 ~/.nanoclaw/agents/
chmod 600 ~/.nanoclaw/.env
```

---

## Troubleshooting

See [`/debug`](../.claude/skills/debug/SKILL.md) for the in-depth guide. Common issues:

| Issue | Cause | Fix |
|-------|-------|-----|
| No response to messages | Service not running | `launchctl list \| grep nanoclaw` |
| Agent error: invalid API key | Missing/wrong `.env` | Check `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` |
| Session not continuing | Daily/idle reset, or transcript deleted | Inspect `~/.nanoclaw/data/sessions.json` and `~/.claude/projects/` |
| WhatsApp QR expired | Auth state stale | `bun run auth` (or delete `~/.nanoclaw/store/auth/` and re-run setup) |
| iMessage messages not arriving | `imsg watch` not appending to `~/.nanoclaw/data/imsg-watch.jsonl` | Verify Full Disk Access; rerun `scripts/setup-imessage.sh` |
| Telegram silent | Bot token missing or bot not added to chat | Check `TELEGRAM_BOT_TOKEN`; `/chatid` in the chat to grab the JID |

### Log locations

- `logs/nanoclaw.log` — host stdout
- `logs/nanoclaw.error.log` — host stderr
- `~/.nanoclaw/agents/{folder}/logs/agent-*.log` — per-run logs
- `~/.claude/projects/{encodedCwd}/{sessionId}.jsonl` — Claude Agent SDK transcripts
