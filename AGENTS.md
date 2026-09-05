# BearClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to chat platforms (WhatsApp, Telegram, iMessage), the Gmail channel, and a local web UI, routing messages to the Claude Agent SDK running directly on the host. Each agent has its own working directory and memory.

The web UI is a Next.js 15 PWA in `web/` (separate package). It talks to a local HTTP/SSE server (`src/server/http.ts`, default `127.0.0.1:7878`) inside the main process. The web app has top-level modules: **Chat**, **Workflows** (list, detail, run view, schedules, event log), **Inbox** (open human steps), **Admin** (skills, agents, context, settings, health, transcripts) and the first-run wizard at `/setup`.

Configuration lives in a SQLite config database at `~/.bearclaw/bearclaw.db` (mode 0600): settings including secrets, the agent registry, context documents, skills, workflow definitions, MCP servers and the model catalog. `~/.bearclaw/var/` is runtime state that BearClaw owns: `messages.db`, session ids, channel credentials, per-agent logs and conversation archives. The SDK needs real files for skills and context, so both are mirrored read-only into `var/cache/skills` and `var/cache/context` on every write, and symlinked into each agent's working directory. There is no `.env` file and `~/.bearclaw` is not a git repo; `bearclaw export` is the backup path. Settings are copied into `process.env` at boot, so changing one takes effect on the next restart.

Auth: signed-cookie session + double-submit CSRF (`src/server/auth.ts`). Single owner password, stored as an scrypt hash in the config database and set by `bearclaw setup` or the web setup wizard. `BEARCLAW_PASSWORD` in the environment overrides the stored hash. Until a password exists the login route answers `setup required`. HMAC secret auto-generated at `~/.bearclaw/var/auth-secret`. Web app gates all routes via `web/middleware.ts`, which also redirects everything to `/setup` until onboarding finishes; API client (`web/lib/api.ts`) attaches `x-csrf-token` from the `nc_csrf` cookie on mutations.

## Source Layout

```
src/
├── index.ts       bootstrap (config DB → process.env), then loads app.ts
├── app.ts         main(): channel wiring, message routing, IPC watcher
├── cli.ts         the `bearclaw` command
├── config.ts, types.ts, logger.ts, db.ts            # trunk
├── store/         config DB: paths, migrations, settings, agents, context,
│                  skills, mcp, models, workflows, materialize, import-legacy
├── cli/           setup, doctor, export, import, plist, templates, whatsapp-auth
├── agent/         runner, session, ipc-mcp, context-tools, hooks, mcp-config,
│                  subprocess-manager, daily-rollover, recall-index, image-gen,
│                  system-prompt
├── channels/      whatsapp, telegram, imessage, email, web, router
├── server/        http (REST + SSE), setup (wizard status), auth, broker
├── admin/         data (skills/events/agents/health ops, used by HTTP layer)
├── workflows/     schema, expr, store, engine, executors, triggers, service
├── commands/      slash commands (/status, /model, /skills, /workflows, …)
├── media/         format, source, transcribe, tts
└── utils/         json, time

templates/         starter context + IDENTITY seeded by `bearclaw setup`
launchd/           plist templates rendered by `bearclaw setup`

web/               # Next.js 15 + PWA. Talks to HTTP server via /api/* rewrite.
├── app/
│   ├── chat/                user chat UI (SSE-streamed)
│   ├── workflows/           workflows list, detail, run view, schedules, events
│   ├── inbox/               open human steps across workflows
│   ├── setup/               first-run wizard
│   └── admin/               skills, agents, context, settings, health, transcripts
├── components/
├── lib/api.ts               REST + SSE client
└── public/sw.js             service worker
```

Memory is in-process, with the durable layers on disk. The 1am rollover flushes
each day to `var/agents/{name}/conversations/{date}.md` and resets the folder's
session, and the agent reaches anything older through
`mcp__bearclaw__recall_history`, a BM25 search over those archives. There is no
external knowledge base; user-held facts live in the `context_files` rows of the
config database (`USER.md`, `SOUL.md`, `AGENTS.md`, `CONTEXT.md`, and per-agent
`IDENTITY.md`), which BearClaw only writes when asked, through
`mcp__bearclaw__context_write` or the Admin > Context editor.

## Key Files

| File                                           | Purpose                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `src/index.ts`                                 | Entry: bootstrap the config DB into env, then hand over to `app.ts`  |
| `src/app.ts`                                   | Main app: channel wiring, message routing, IPC watcher               |
| `src/cli.ts`                                   | `bearclaw` CLI: setup, doctor, export, import, config, workflows     |
| `src/config.ts`                                | Env vars, paths, trigger pattern, intervals                          |
| `src/store/bootstrap.ts`                       | var layout, opens `bearclaw.db`, loads settings into `process.env`   |
| `src/store/materialize.ts`                     | Mirrors skills + context into `var/cache/`, links them per agent     |
| `src/agent/runner.ts`                          | Runs the Claude Agent SDK in-process; warm-start hook                |
| `src/agent/ipc-mcp.ts`                         | MCP tools for agent ↔ host communication                             |
| `src/agent/daily-rollover.ts`                  | 1am conversation flush + session reset                               |
| `src/agent/image-gen.ts`                       | Image generation client (OpenAI gpt-image-2 + Google nano-banana)    |
| `src/workflows/engine.ts`                      | Workflow decider: steps, retries, waits, recovery                    |
| `src/workflows/triggers.ts`                    | Cron, one-shot, event and webhook triggers                           |
| `src/channels/email.ts`                        | Gmail polling and reply primitive                                    |
| `src/db.ts`                                    | Runtime SQLite (messages, chats, events, workflow state)             |
| `~/.bearclaw/bearclaw.db`                      | Config DB: settings, agents, context, skills, workflows, MCP, models |
| `~/.bearclaw/var/cache/skills/`                | Read-only mirror of the skill rows (what the SDK discovers)          |
| `~/.bearclaw/var/cache/context/`               | Read-only mirror of the context rows (`shared/`, `agents/{folder}/`) |
| `~/.bearclaw/var/agents/{name}/conversations/` | Daily conversation archives (`YYYY-MM-DD.md`, written by 1am flush)  |
| `~/.bearclaw/var/agents/{name}/checkpoints/`   | Older transcript checkpoints, still searched by `recall_history`     |

Writes under `var/cache/` are denied to the agent by a `PreToolUse` hook
(`src/agent/hooks.ts`): the rows are the source of truth, the mirror is a copy.

## Skills

| Skill        | When to Use                                      |
| ------------ | ------------------------------------------------ |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug`     | Agent issues, logs, troubleshooting              |

Known stale: `customize`, `debug` and the `add-*` skills were written before the
config database (2026-09) and still describe `.env` files and container-era
steps. Prefer `bearclaw doctor`, `bearclaw config` and Admin > Settings.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run setup        # Install or repair this machine (idempotent); --yes for no prompts
npm run doctor       # One line per check; exits 1 on a failure
npm run dev          # Run main process with hot reload (HTTP server on 127.0.0.1:7878)
npm run build        # Compile TypeScript
npm run auth         # Re-pair WhatsApp by QR code

npm run cli -- config list          # Settings, secrets redacted
npm run cli -- config set KEY VALUE # Write one setting (restart to apply)
npm run cli -- export               # Bundle of config DB + channel credentials
npm run cli -- import bundle.tgz    # Restore one onto this machine

# Web app (Next.js 15 PWA, separate node_modules in web/)
npm run web:dev      # Next dev server on :3030, /api/* proxies to backend
npm run web:build
npm run web:start
```

After `npm run build` the same commands are on `PATH` as `bearclaw setup`,
`bearclaw doctor`, `bearclaw export`, `bearclaw import`. Export bundles hold
secrets in the clear.

First-time web setup: `cd web && bun install`.

Service management:

```bash
# Main process (channels + scheduler + HTTP API on 127.0.0.1:7878)
launchctl load   ~/Library/LaunchAgents/com.bearclaw.plist
launchctl unload ~/Library/LaunchAgents/com.bearclaw.plist

# Web UI (Next.js prod, :3030; proxies /api/* -> 7878)
launchctl load   ~/Library/LaunchAgents/com.bearclaw.web.plist
launchctl unload ~/Library/LaunchAgents/com.bearclaw.web.plist
```

`bearclaw setup` writes both plists from `launchd/*.plist` and starts them.
Settings changes need a restart: `launchctl kickstart -k gui/$(id -u)/com.bearclaw`.

Web service prerequisite: `cd web && bun install && bun run build`. Reload `com.bearclaw.web` after every rebuild.
