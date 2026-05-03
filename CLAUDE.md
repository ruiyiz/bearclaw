# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to chat platforms (WhatsApp, Telegram, iMessage) and the Gmail integration, routes messages to the Claude Agent SDK running directly on the host. Each agent has its own working directory and memory.

## Source Layout

```
src/
├── index.ts, config.ts, types.ts, logger.ts, db.ts   # trunk
├── agent/         runner, ipc-mcp, subprocess-manager, memory-flusher, system-prompt
├── channels/      whatsapp, telegram, imessage, router
├── events/        bus, scheduler, heartbeat
├── integrations/  email
├── media/         format, source, transcribe, tts
├── utils/         json, time
├── scripts/       whatsapp-auth
└── tui/           …
```

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main app: channel wiring, message routing, IPC watcher |
| `src/config.ts` | Env vars, paths, trigger pattern, intervals |
| `src/agent/runner.ts` | Runs the Claude Agent SDK in-process |
| `src/agent/ipc-mcp.ts` | MCP tools for agent ↔ host communication |
| `src/events/bus.ts` | Event dispatch + handler runner |
| `src/events/scheduler.ts` | Cron handler firing |
| `src/integrations/email.ts` | Gmail polling and reply primitive |
| `src/db.ts` | SQLite operations |
| `~/.nanoclaw/context/` | Shared context: AGENTS.md, SOUL.md, USER.md, MEMORY.md |
| `~/.nanoclaw/agents/{name}/IDENTITY.md` | Per-agent identity |
| `~/.nanoclaw/skills/` | Skill definitions (SKILL.md per skill) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Agent issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
```

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```
