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

Each group runs with its own working directory (`~/.nanoclaw/groups/{folder}/`) and conversation session. The agent's `cwd` is set to the group folder, and `settingSources: ['project']` reads CLAUDE.md from there. IPC authorization ensures non-main groups can only message their own chat and manage their own tasks.

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

A personal Claude assistant accessible via WhatsApp, with minimal custom code.

**Core components:**
- **Claude Agent SDK** as the core agent, running directly on the host
- **WhatsApp** as the primary I/O channel
- **Persistent memory** per conversation and globally
- **Scheduled tasks** that run Claude and can message back
- **Web access** for search and browsing

**Implementation approach:**
- Use existing tools (WhatsApp connector, Claude Agent SDK, MCP servers)
- Minimal glue code
- File-based systems where possible (CLAUDE.md for memory, `~/.nanoclaw/groups/` for group data)

---

## Architecture Decisions

### Message Routing
- A router listens to WhatsApp and routes messages based on configuration
- Only messages from registered groups are processed
- Trigger: `@Andy` prefix (case insensitive), configurable via `ASSISTANT_NAME` env var
- Unregistered groups are ignored completely

### Memory System
- **Per-group memory**: Each group has a folder under `~/.nanoclaw/groups/` with its own `CLAUDE.md`
- **Global memory**: Root `CLAUDE.md` is read by all groups, but only writable from "main" (self-chat)
- **Files**: Groups can create/read files in their `~/.nanoclaw/groups/{folder}/` directory and reference them
- Agent runs in the group's folder, automatically inherits both CLAUDE.md files

### Session Management
- Each group maintains a conversation session (via Claude Agent SDK)
- Sessions auto-compact when context gets too long, preserving critical information

### Agent Execution
- Agents run via the Claude Agent SDK directly in the host process
- Each agent invocation calls `query()` with the group's directory as `cwd`
- No OS-level filesystem isolation between groups — agents have host filesystem access
- Session isolation is per-group (each group has its own `cwd` and session ID)
- IPC authorization enforces group-level permission boundaries

### Scheduled Tasks
- Users can ask Claude to schedule recurring or one-time tasks from any group
- Tasks run as full agents in the context of the group that created them
- Tasks have access to all tools including Bash
- Tasks can optionally send messages to their group via `send_message` tool, or complete silently
- Task runs are logged to the database with duration and result
- Schedule types: cron expressions, intervals (ms), or one-time (ISO timestamp)
- From main: can schedule tasks for any group, view/manage all tasks
- From other groups: can only manage that group's tasks

### Group Management
- New groups are added explicitly via the main channel
- Groups are registered by editing `~/.nanoclaw/data/registered_groups.json`
- Each group gets a dedicated folder under `~/.nanoclaw/groups/`
- Groups can have per-group configuration via `containerConfig` (e.g., custom timeout)

### Main Channel Privileges
- Main channel is the admin/control group (typically self-chat)
- Can write to global memory (`~/.nanoclaw/groups/CLAUDE.md`)
- Can schedule tasks for any group
- Can view and manage tasks from all groups
- Can configure per-group settings

---

## Integration Points

### WhatsApp
- Using baileys library for WhatsApp Web connection
- Messages stored in SQLite, polled by router
- QR code authentication during setup

### Scheduler
- Built-in scheduler runs in the host process, invokes agents for task execution
- Custom `nanoclaw` MCP server provides scheduling tools
- Tools: `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `send_message`
- Tasks stored in SQLite with run history
- Scheduler loop checks for due tasks every minute
- Tasks execute Claude Agent SDK in the group's directory context

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
