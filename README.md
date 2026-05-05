<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  My personal Claude assistant. Lightweight and built to be understood and customized for your own needs.
</p>

## Why I Built This

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project with a great vision. But I can't sleep well running software I don't understand with access to my life. OpenClaw has 52+ modules, 8 config management files, 45+ dependencies, and abstractions for 15 channel providers. Security is application-level (allowlists, pairing codes) rather than OS isolation. Everything runs in one Node process with shared memory.

NanoClaw gives you the same core functionality in a codebase you can understand in 8 minutes. One process. A handful of files. Agents run via the Claude Agent SDK directly on your machine.

## Quick Start

```bash
git clone https://github.com/gavrielc/nanoclaw.git
cd nanoclaw
claude
```

Then run `/setup`. Claude Code handles everything: dependencies, authentication, service configuration.

## Philosophy

**Small enough to understand.** One process, a few source files. No microservices, no message queues, no abstraction layers. Have Claude Code walk you through it.

**Built for one user.** This isn't a framework. It's working software that fits my exact needs. You fork it and have Claude Code make it match your exact needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that this is safe.

**AI-native.** No installation wizard; Claude Code guides setup. No monitoring dashboard; ask Claude what's happening. No debugging tools; describe the problem, Claude fixes it.

**Skills over features.** Contributors shouldn't add features (e.g. support for Telegram) to the codebase. Instead, they contribute [claude code skills](https://code.claude.com/docs/en/skills) like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Best harness, best model.** This runs on Claude Agent SDK, which means you're running Claude Code directly. The harness matters. A bad harness makes even smart models seem dumb, a good harness gives them superpowers. Claude Code is (IMO) the best harness available.

## What It Supports

- **WhatsApp I/O** - Message Claude from your phone
- **Isolated agent context** - Each agent has its own `IDENTITY.md`, working directory, memory, and conversation session
- **Main channel** - Your private channel (self-chat) for admin control; every other agent is isolated
- **Scheduled tasks & event handlers** - Recurring jobs and event-driven handlers that run Claude and can message you back
- **Web access** - Search and fetch content
- **Optional channels & integrations** - Add Telegram (`/add-telegram`), iMessage (`/add-imessage`), Gmail (`/add-gmail`), and more via skills

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage agents and tasks:

```
@Andy list all scheduled tasks across agents
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

There are no configuration files to learn. Just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that adds Telegram alongside WhatsApp. Instead, contribute a skill file (`.claude/skills/add-telegram/SKILL.md`) that teaches Claude Code how to transform a NanoClaw installation to use Telegram.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Skills)

Skills we'd love to see:

**Communication Channels**

- `/add-telegram` - Add Telegram as channel. Should give the user option to replace WhatsApp or add as additional channel. Also should be possible to add it as a control channel (where it can trigger actions) or just a channel that can be used in actions triggered elsewhere
- `/add-slack` - Add Slack
- `/add-discord` - Add Discord

**Platform Support**

- `/setup-windows` - Windows via WSL2
- `/setup-linux` - Linux setup

**Session Management**

- `/add-clear` - Add a `/clear` command that compacts the conversation (summarizes context while preserving critical information in the same session). Requires figuring out how to trigger compaction programmatically via the Claude Agent SDK.

## Requirements

- macOS
- Node.js 20+
- [Claude Code](https://claude.ai/download) (`npm install -g @anthropic-ai/claude-code`)

## Service Management

NanoClaw runs as a launchd service (`~/Library/LaunchAgents/com.nanoclaw.plist`).

```bash
# Start
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Stop
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Restart
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Check status
launchctl list | grep nanoclaw
```

Logs:

```bash
tail -f logs/nanoclaw.log        # Main log
tail -f logs/nanoclaw.error.log  # Errors
cat ~/.nanoclaw/agents/main/logs/agent-*.log | tail -50  # Agent logs
```

Re-authenticate WhatsApp (if disconnected):

```bash
npm run auth
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Architecture

```
WhatsApp (baileys) --> SQLite --> Polling loop --> Claude Agent SDK (in-process) --> Response
```

Single Node.js process. Agents execute via the Claude Agent SDK directly in the host process with per-agent working directories. IPC via filesystem. No daemons, no queues, no complexity.

Key files:

- `src/index.ts` - Main app: channel connections, routing, IPC
- `src/agent/runner.ts` - Runs the Claude Agent SDK in-process
- `src/agent/ipc-mcp.ts` - MCP tools for agent ↔ host communication (send_message, schedule_task, memory, image_generate, …)
- `src/events/scheduler.ts` - Runs scheduled handlers
- `src/events/bus.ts` - Dispatches events to handlers
- `src/db.ts` - SQLite operations
- `~/.nanoclaw/agents/{name}/IDENTITY.md` - Per-agent identity
- `~/.nanoclaw/context/{AGENTS,SOUL,USER,MEMORY}.md` - Shared context

## FAQ

**Why WhatsApp and not Telegram/Signal/etc?**

Because I use WhatsApp. Fork it and run a skill to change it. That's the whole point.

**Is this secure?**

Agents run directly on the host, so they have access to the host filesystem. Each agent runs with `cwd` set to its own `~/.nanoclaw/agents/{folder}/` directory, and the `settingSources: ['project']` option means it reads project settings from that folder. However, there is no OS-level isolation between agents — a determined prompt injection could access files outside the agent folder. For stronger isolation, you could run NanoClaw in a container itself. See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize it to so that the code matches exactly what they want rather than configuring a generic system. If you like having config files, tell Claude to add them.

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach.

**Why isn't the setup working for me?**

I don't know. Run `claude`, then run `/debug`. If claude finds an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

**What changes will be accepted into the codebase?**

Security fixes, bug fixes, and clear improvements to the base configuration. That's it.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## License

MIT
