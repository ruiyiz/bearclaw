# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to chat platforms (WhatsApp, Telegram, iMessage), the Gmail integration, and a local web UI, routing messages to the Claude Agent SDK running directly on the host. Each agent has its own working directory and memory.

The web UI is a Next.js 15 PWA in `web/` (separate package). It talks to a local HTTP/SSE server (`src/server/http.ts`, default `127.0.0.1:7878`) inside the main process. The web app has two module groups: **user** (chat, events) and **admin** (skills, handlers, agents, health, heartbeat).

Auth: signed-cookie session + double-submit CSRF (`src/server/auth.ts`). Single owner password from `NANOCLAW_PASSWORD` in `~/.nanoclaw/.env`. If unset on first start, a random password is written to `~/.nanoclaw/var/initial-password` and logged once — copy it to the env file then delete the bootstrap file. HMAC secret auto-generated at `~/.nanoclaw/var/auth-secret`. Web app gates all routes via `web/middleware.ts`; API client (`web/lib/api.ts`) attaches `x-csrf-token` from the `nc_csrf` cookie on mutations.

## Source Layout

```
src/
├── index.ts, config.ts, types.ts, logger.ts, db.ts   # trunk
├── agent/         runner, ipc-mcp, subprocess-manager, conversation-checkpoint, image-gen, system-prompt
├── channels/      whatsapp, telegram, imessage, web, router
├── server/        http (REST + SSE), broker (web outbound fan-out)
├── admin/         data (skills/events/handlers/agents/health/heartbeat ops, used by HTTP layer)
├── events/        bus, scheduler, heartbeat
├── integrations/  email
├── media/         format, source, transcribe, tts
├── utils/         json, time
└── scripts/       whatsapp-auth

web/               # Next.js 15 + PWA. Talks to HTTP server via /api/* rewrite.
├── app/
│   ├── chat/                user chat UI (SSE-streamed)
│   ├── events/              user event feed
│   └── admin/               admin pages: skills, events, handlers, agents, health, heartbeat
├── components/
├── lib/api.ts               REST + SSE client
└── public/sw.js             service worker
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
| `~/.nanoclaw/var/agents/{name}/conversations/` | Daily conversation archives (`YYYY-MM-DD.md`, written by 1am flush)  |
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
npm run dev          # Run main process with hot reload (HTTP server on 127.0.0.1:7878)
npm run build        # Compile TypeScript

# Web app (Next.js 15 PWA, separate node_modules in web/)
npm run web:dev      # Next dev server on :3030, /api/* proxies to backend
npm run web:build
npm run web:start
```

First-time web setup: `cd web && bun install`.

Service management:

```bash
# Main process (channels + scheduler + HTTP API on 127.0.0.1:7878)
launchctl load   ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Web UI (Next.js prod, :3030; proxies /api/* -> 7878)
launchctl load   ~/Library/LaunchAgents/com.nanoclaw.web.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.web.plist
```

Web service prerequisite: `cd web && bun install && bun run build`. Reload `com.nanoclaw.web` after every rebuild.
