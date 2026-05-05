# NanoClaw Requirements

Original requirements and design decisions from the project creator.

---

## Why This Exists

This is a lightweight, secure alternative to OpenClaw (formerly ClawBot). That project became a monstrosity - 4-5 different processes running different gateways, endless configuration files, endless integrations. It's a security nightmare where agents don't run in isolated processes; there's all kinds of leaky workarounds trying to prevent them from accessing parts of the system they shouldn't. It's impossible for anyone to realistically understand the whole codebase. When you run it you're kind of just yoloing it.

NanoClaw gives you the core functionality without that mess.

---

## Philosophy

### Small Enough to Understand

The entire codebase should be something you can read and understand. One Node.js process. A handful of source files. No microservices, no message queues, no abstraction layers.

### Session Isolation

Each agent runs with its own working directory (`~/.nanoclaw/agents/{folder}/`) and conversation session. The agent's `cwd` is set to the agent folder, and `settingSources: ['project']` reads project settings from there. IPC authorization ensures non-main agents can only message their own chats and manage their own handlers.

### Built for One User

This isn't a framework or a platform. It's working software for my specific needs. I use WhatsApp and Email, so it supports WhatsApp and Email. I don't use Telegram, so it doesn't support Telegram. I add the integrations I actually want, not every possible integration.

### Customization = Code Changes

No configuration sprawl. If you want different behavior, modify the code. The codebase is small enough that this is safe and practical. Very minimal things like the trigger word are in config. Everything else - just change the code to do what you want.

### AI-Native Development

I don't need an installation wizard - Claude Code guides the setup. I don't need a monitoring dashboard - I ask Claude Code what's happening. I don't need elaborate logging UIs - I ask Claude to read the logs. I don't need debugging tools - I describe the problem and Claude fixes it.

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

A personal Claude assistant accessible via chat platforms, with minimal custom code.

**Core components:**

- **Claude Agent SDK** as the core agent, running directly on the host
- **Channels** (WhatsApp, Telegram, iMessage) as I/O surfaces
- **Integrations** (Gmail) as event sources
- **Persistent memory** per agent and shared across all agents
- **Scheduled tasks & event handlers** that run Claude and can message back
- **Web access** for search and browsing

**Implementation approach:**

- Use existing tools (WhatsApp connector, Claude Agent SDK, MCP servers)
- Minimal glue code
- File-based systems where possible (`~/.nanoclaw/context/` for shared memory, `~/.nanoclaw/agents/` for per-agent data)

---

## Architecture Decisions

### Message Routing

- Channel adapters (WhatsApp, Telegram, iMessage) deliver inbound messages, which the router dispatches based on chat JID
- Only messages from registered chats trigger an agent
- Trigger: `@Andy` prefix (case insensitive), configurable via `ASSISTANT_NAME` env var
- Unregistered chats are ignored

### Memory System

- **Shared context**: `~/.nanoclaw/context/{AGENTS,SOUL,USER,MEMORY}.md` is loaded into every agent's prompt
- **Per-agent identity**: `~/.nanoclaw/agents/{name}/IDENTITY.md` defines the agent's role/persona
- **Daily memory**: `~/.nanoclaw/agents/{name}/memory/YYYY-MM-DD.md` is appended via `memory_write` and indexed for `memory_search`
- **Conversations**: archived to `~/.nanoclaw/agents/{name}/conversations/` when sessions reset
- Agent runs with its folder as `cwd`; the SDK reads `.claude/` project settings from there

### Session Management

- Each agent maintains a conversation session (via Claude Agent SDK)
- Daily reset hour and idle reset minutes are configurable via `SESSION_RESET_HOUR` and `SESSION_IDLE_MINUTES`
- Sessions auto-compact when context gets too long, preserving critical information

### Agent Execution

- Agents run via the Claude Agent SDK directly in the host process
- Each agent invocation calls `query()` with the agent's directory as `cwd`
- No OS-level filesystem isolation between agents — agents have host filesystem access
- Session isolation is per-agent (each has its own `cwd` and session ID)
- IPC authorization enforces per-agent permission boundaries

### Handlers (Scheduled Tasks + Event Handlers)

- A unified `handlers` table in SQLite stores both cron-scheduled handlers and event-driven handlers
- The scheduler emits `cron_trigger` events when handlers are due; the event bus runs matching handlers
- Handlers run as full agents (with all tools) in either `agent` (shared session) or `isolated` (fresh session) context mode
- Handlers can optionally send messages via the IPC MCP, or complete silently
- Each run is logged to the database with duration and result
- Built-in event types: `cron_trigger`, `handler_complete`, `agent_complete`, `email_received`, `subprocess_exit`, `subprocess_notification`
- From main: can register/manage handlers for any agent
- From other agents: can only manage their own handlers

### Agent Management

- New agents are registered via the `register_agent` MCP tool (main only) or directly via `~/.nanoclaw/data/registered_agents.json`
- Each agent gets a dedicated folder under `~/.nanoclaw/agents/`
- Agents can have per-agent configuration: `containerConfig.timeout`, `heartbeat`, `email`, `activeHours`

### Main Channel Privileges

- Main channel is the admin/control surface (typically self-chat)
- Can write to shared `~/.nanoclaw/context/MEMORY.md`
- Can register handlers and agents for any folder
- Can view and manage handlers across all agents
- Can configure per-agent settings

---

## Integration Points

### Channels

- **WhatsApp**: baileys library; QR auth during setup
- **Telegram**: grammY; bot token + optional bot pool for agent swarms
- **iMessage**: file-tail of `imsg watch --json`; needs Full Disk Access
- Messages are stored in SQLite; the router dispatches to per-agent processing queues

### Integrations

- **Email** (`src/integrations/email.ts`): polls Gmail via the `gog` CLI, emits `email_received` events; reply primitive available to agents via the `reply_email` MCP tool

### Handlers + MCP Tools

- Scheduler and event bus run in the host process, invoke agents for handler execution
- The custom `nanoclaw` MCP server (in `src/agent/ipc-mcp.ts`) exposes:
  - `send_message`, `schedule_task`, `register_handler`, `pause_handler`, `resume_handler`, `cancel_handler`, `list_handlers`
  - `emit_event`, `register_agent`, `reply_email`
  - `memory_write`, `memory_search`
  - `subprocess_start/read/write/poll/kill/list`
  - `image_generate` (registered when either `OPENAI_API_KEY` or `GOOGLE_API_KEY` is set; routes by model — `gpt-image-*` → OpenAI, `nano-banana`/`gemini-*` → Google)
- Handlers stored in SQLite with run history
- Scheduler checks for due cron handlers every minute; the event bus drains the queue every 5 seconds

### Web Access

- Built-in WebSearch and WebFetch tools
- Standard Claude Agent SDK capabilities

---

## Setup & Customization

### Philosophy

- Minimal configuration files
- Setup and customization done via Claude Code
- Users clone the repo and run Claude Code to configure
- Each user gets a custom setup matching their exact needs

### Skills

- `/setup` - Install dependencies, authenticate WhatsApp, configure scheduler, start services
- `/customize` - General-purpose skill for adding capabilities (new channels like Telegram, new integrations, behavior changes)

### Deployment

- Runs on local Mac via launchd
- Single Node.js process handles everything

---

## Personal Configuration (Reference)

These are the creator's settings, stored here for reference:

- **Trigger**: `@Andy` (case insensitive)
- **Response prefix**: `Andy:`
- **Persona**: Default Claude (no custom personality)
- **Main channel**: Self-chat (messaging yourself in WhatsApp)

---

## Project Name

**NanoClaw** - A reference to Clawdbot (now OpenClaw).
