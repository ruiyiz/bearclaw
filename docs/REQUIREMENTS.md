# BearClaw Requirements

Original requirements and design decisions from the project creator.

---

## Why This Exists

This is a lightweight, secure alternative to OpenClaw (formerly ClawBot). That project became a monstrosity - 4-5 different processes running different gateways, endless configuration files, endless integrations. It's a security nightmare where agents don't run in isolated processes; there's all kinds of leaky workarounds trying to prevent them from accessing parts of the system they shouldn't. It's impossible for anyone to realistically understand the whole codebase. When you run it you're kind of just yoloing it.

BearClaw gives you the core functionality without that mess.

---

## Philosophy

### Small Enough to Understand

The entire codebase should be something you can read and understand. One Node.js process. A handful of source files. No microservices, no message queues, no abstraction layers.

### Session Isolation

Each agent runs with its own working directory (`~/.bearclaw/var/agents/{folder}/`) and conversation session. The agent's `cwd` is set to that folder, and `settingSources: ['project']` reads project settings from there, including the skills mirrored into `.claude/skills`. IPC authorization ensures non-main agents can only message their own chats and manage their own workflows.

### Built for One User

This isn't a framework or a platform. It's working software for my specific needs. I use WhatsApp and Email, so it supports WhatsApp and Email. I don't use Telegram, so it doesn't support Telegram. I add the integrations I actually want, not every possible integration.

### Customization = Code Changes

No configuration sprawl. If you want different behavior, modify the code. The codebase is small enough that this is safe and practical. Minimal things like the trigger word, the model and the API tokens are settings rows in the config database, reachable from `bearclaw config` and Admin > Settings. Everything else - just change the code to do what you want.

### AI-Native Development

Installation is one command (`npm run setup`) plus a browser page, not a manual. I don't need a monitoring dashboard - I ask Claude Code what's happening. I don't need elaborate logging UIs - I ask Claude to read the logs. I don't need debugging tools - I describe the problem and Claude fixes it.

The codebase assumes you have an AI collaborator. It doesn't need to be excessively self-documenting or self-debugging because Claude is always there.

### Skills Over Features

When people contribute, they shouldn't add "Telegram support alongside WhatsApp." They should contribute a skill like `/add-telegram` that transforms the codebase. Users fork the repo, run skills to customize, and end up with clean code that does exactly what they need - not a bloated system trying to support everyone's use case simultaneously.

---

## RFS (Request for Skills)

Skills we'd love contributors to build:

### Communication Channels

Skills to add or switch to different messaging platforms:

- `/add-telegram` - Add Telegram as an input channel
- `/add-slack` - Add Slack as an input channel
- `/add-discord` - Add Discord as an input channel
- `/add-sms` - Add SMS via Twilio or similar
- `/convert-to-telegram` - Replace WhatsApp with Telegram entirely

### Platform Support

- `/setup-linux` - Make the full setup work on Linux
- `/setup-windows` - Windows support via WSL2

---

## Vision

A personal AI assistant accessible via chat platforms, with minimal custom code.

**Core components:**

- **Agent backend** running directly on the host: Pi (including ChatGPT Codex authentication) or the Claude Agent SDK
- **Channels** (WhatsApp, Telegram, iMessage) as I/O surfaces
- **Integrations** (Gmail) as event sources
- **Persistent memory** per agent and shared across all agents
- **Workflows** — scheduled or event-driven flowcharts of typed nodes, with human steps
- **Web access** for search and browsing

**Implementation approach:**

- Use existing tools (channel connectors, Pi or Claude Agent SDK, MCP servers)
- Minimal glue code
- One SQLite config database (`~/.bearclaw/bearclaw.db`) for everything durable the user owns, mirrored to files under `~/.bearclaw/var/cache/` where the SDK needs real files; `~/.bearclaw/var/` for runtime state

---

## Architecture Decisions

### Message Routing

- Channel adapters (WhatsApp, Telegram, iMessage) deliver inbound messages, which the router dispatches based on chat JID
- Only messages from registered chats trigger an agent
- Trigger: `@Andy` prefix (case insensitive), configurable via the `ASSISTANT_NAME` setting (env var of the same name overrides it)
- Unregistered chats are ignored

### Memory System

- **Shared context**: the `shared` context rows (`AGENTS.md`, `SOUL.md`, `USER.md`, `CONTEXT.md`) are loaded into every agent's prompt
- **Per-agent identity**: the agent's `IDENTITY.md` row defines its role/persona
- **Conversations**: the 1am rollover writes each day to `~/.bearclaw/var/agents/{name}/conversations/{date}.md`
- **Recall**: `recall_history` runs BM25 search over those archives; there is no separate memory store
- Context rows are mirrored read-only to `~/.bearclaw/var/cache/context/` and linked into each agent's `cwd`; agents change them through `context_write`, never by editing the mirror
- Agent runs with `~/.bearclaw/var/agents/{folder}/` as `cwd`; the SDK reads `.claude/` project settings from there

### Session Management

- Each agent maintains a conversation session through the selected backend
- Daily reset hour and idle reset minutes are configurable via `SESSION_RESET_HOUR` and `SESSION_IDLE_MINUTES`
- Sessions auto-compact when context gets too long, preserving critical information

### Agent Execution

- Agents run through the selected agent backend directly in the host process
- Each agent invocation calls `query()` with the agent's directory as `cwd`
- No OS-level filesystem isolation between agents — agents have host filesystem access
- Session isolation is per-agent (each has its own `cwd` and session ID)
- IPC authorization enforces per-agent permission boundaries

### Workflows (Scheduled + Event-Driven)

- A workflow is a flowchart of typed nodes stored as a JSON definition in the config database (`workflow_definitions`); most nodes are not LLM calls
- Triggers are separate rows binding a firing condition (cron, at, event, webhook, manual) to a workflow and supplying its inputs
- A run snapshots the definition, persists after every step, and resumes from the database after a restart
- Human steps park a run on a `workflow_waits` row and resolve from the web inbox, a channel reply, or the agent's `workflow_respond`
- Every run, step and wait is recorded, with an append-only timeline per run
- Built-in event types: `agent_complete`, `email_received`, `subprocess_exit`, `subprocess_notification`
- From main: can manage workflows and triggers for any agent
- From other agents: only their own workflows, and events prefixed with their folder

### Agent Management

- New agents are registered via the `register_agent` MCP tool (main only), Admin > Agents, or the `agents` table in the config database
- Each agent gets a dedicated folder under `~/.bearclaw/var/agents/`
- Agents can have per-agent configuration: `containerConfig.timeout`, `email`, `activeHours`

### Main Channel Privileges

- Main channel is the admin/control surface (typically self-chat)
- Can write the shared context rows through `context_write`
- Can register workflows, triggers and agents for any folder
- Can view and manage workflows across all agents
- Can configure per-agent settings

---

## Integration Points

### Channels

- **WhatsApp**: baileys library; QR auth during setup
- **Telegram**: grammY; bot token + optional bot pool for agent swarms
- **iMessage**: file-tail of `imsg watch --json`; needs Full Disk Access
- Messages are stored in SQLite; the router dispatches to per-agent processing queues

### Integrations

- **Email** (`src/channels/email.ts`): polls Gmail via the `gog` CLI, emits `email_received` events; reply primitive available to agents via the `reply_email` MCP tool

### Workflows + MCP Tools

- Workflows (`src/workflows/`) are the only invocation primitive: a definition file of typed nodes, triggers that bind a firing condition to it, and a durable interpreter in the host process
- The custom `bearclaw` MCP server (in `src/agent/ipc-mcp.ts`) exposes:
  - `send_message`, `emit_event`, `register_agent`, `reply_email`
  - `workflow_list`, `workflow_upsert`, `workflow_delete`, `workflow_run`, `workflow_runs`, `workflow_set_enabled`, `workflow_waits`, `workflow_respond`, `run_cancel`
  - `trigger_create`, `trigger_list`, `trigger_set_enabled`, `trigger_delete`
  - `subprocess_start/read/write/poll/kill/list`
  - `image_generate` (registered when either `OPENAI_API_KEY` or `GOOGLE_API_KEY` is set; routes by model — `gpt-image-*` → OpenAI, `nano-banana`/`gemini-*` → Google)
- Definitions live in the config database; runs, steps, waits and triggers live in `var/messages.db`
- One service loop drives event triggers, due cron and one-shot rows, and the engine's own timers

### Web Access

- Built-in WebSearch and WebFetch tools
- Backend-provided capabilities, plus BearClaw host tools

---

## Setup & Customization

### Philosophy

- No configuration files to hand-edit: one config database, reachable from the CLI and the web admin
- Installation is scripted; customization is still done via Claude Code
- Users clone the repo, run `npm run setup`, and finish in the browser
- Each user gets a custom setup matching their exact needs

### Install path

- `npm run setup` (`bearclaw setup`) fills the config database, seeds the starter context, renders the launchd agents, builds and starts the services. Idempotent.
- The first-run wizard at `/setup` covers whatever setup left open: password, model, Claude token, starter context, channels.
- `bearclaw doctor` checks an install; `bearclaw export` / `bearclaw import` move one between machines.

### Skills

- `/customize` - General-purpose skill for adding capabilities (new channels like Telegram, new integrations, behavior changes). Predates the config database, so parts of it are stale.

### Deployment

- Runs on local Mac via launchd
- Single Node.js process handles everything

---

## Personal Configuration (Reference)

These are the creator's settings, stored here for reference. They live as rows in `~/.bearclaw/bearclaw.db` (`bearclaw config list`):

- **Trigger**: `@Andy` (case insensitive), from the `ASSISTANT_NAME` setting
- **Response prefix**: `Andy:`
- **Persona**: Default Claude (no custom personality)
- **Main channel**: Self-chat (messaging yourself in WhatsApp)

---

## Project Name

**BearClaw** - A reference to Clawdbot (now OpenClaw).
