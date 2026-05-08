# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to chat platforms (WhatsApp, Telegram, iMessage) and the Gmail integration, routes messages to the Claude Agent SDK running directly on the host. Each agent has its own working directory and memory.

## Source Layout

```
src/
├── index.ts, config.ts, types.ts, logger.ts, db.ts   # trunk
├── agent/         runner, ipc-mcp, subprocess-manager, conversation-checkpoint, image-gen, system-prompt
├── channels/      whatsapp, telegram, imessage, router
├── events/        bus, scheduler, heartbeat
├── integrations/  email
├── media/         format, source, transcribe, tts
├── utils/         json, time
├── scripts/       whatsapp-auth
└── tui/           …
```

Long-term memory lives in **gbrain**, spawned as a stdio MCP per agent session
(entry in `~/.nanoclaw/config/mcp.json`). gbrain's PGLite store + cron wrappers
live at `~/.gbrain/`. NanoClaw never imports gbrain code — coupling is the
mcp.json entry only. Drop the entry and the agent still boots, falling back to
checkpoint + last-N-days conversation window. Mutating gbrain ops are denied
at the SDK boundary in `runner.ts`, so the agent sees a read-only view; cron
jobs and the operator's CLI retain full write access.

## Key Files

| File                                           | Purpose                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `src/index.ts`                                 | Main app: channel wiring, message routing, IPC watcher               |
| `src/config.ts`                                | Env vars, paths, trigger pattern, intervals                          |
| `src/agent/runner.ts`                          | Runs the Claude Agent SDK in-process; warm-start hook                |
| `src/agent/ipc-mcp.ts`                         | MCP tools for agent ↔ host communication                             |
| `src/agent/conversation-checkpoint.ts`         | Periodic transcript checkpoint + session-end conversation archive    |
| `src/agent/image-gen.ts`                       | Image generation client (OpenAI gpt-image-2 + Google nano-banana)    |
| `src/events/bus.ts`                            | Event dispatch + handler runner                                      |
| `src/events/scheduler.ts`                      | Cron handler firing                                                  |
| `src/integrations/email.ts`                    | Gmail polling and reply primitive                                    |
| `src/db.ts`                                    | SQLite operations (messages, chats, events, handlers)                |
| `~/.nanoclaw/context/`                         | Shared context: AGENTS.md, CONTEXT.md, SOUL.md, USER.md              |
| `~/.nanoclaw/agents/{name}/IDENTITY.md`        | Per-agent identity                                                   |
| `~/.nanoclaw/var/agents/{name}/conversations/` | Session-end conversation archives (`YYYY-MM-DD-name.md`)             |
| `~/.nanoclaw/var/agents/{name}/checkpoints/`   | Live transcript checkpoint per session (crash safety)                |
| `~/.nanoclaw/skills/`                          | Skill definitions (SKILL.md per skill)                               |
| `~/.gbrain/`                                   | gbrain PGLite store + cron wrappers + logs; populated by gbrain sync |

## Skills

| Skill        | When to Use                                                    |
| ------------ | -------------------------------------------------------------- |
| `/setup`     | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior               |
| `/debug`     | Agent issues, logs, troubleshooting                            |

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
