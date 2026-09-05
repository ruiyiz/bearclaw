# Config Database + Onboarding

**Status: shipped, 2026-09-05** (branch `feat/config-db-onboarding`, seven
commits, listed under [Phases](#phases-as-shipped)).

Two features in one cutover: (A) a real install path, and (B) a SQLite config
database that becomes the source of truth for everything the user owns outside
`~/.bearclaw/var/`.

## Context

A fresh-machine install used to mean a stale `/setup` Claude Code skill with
wrong paths, a hand-written `.env`, a hand-edited `registered_agents.json`,
plists with unsubstituted `{{placeholders}}`, no context templates, and no
first-run UI. Durable state was scattered across
`~/.bearclaw/{.env,context,agents,skills,workflows,config/*.json}`, workflows
even kept an `fs.watch` over their definition directory, and `~/.bearclaw` was
itself a git repo the user was expected to commit by hand.

## Locked decisions

| Item            | Value                                                                     |
| --------------- | ------------------------------------------------------------------------- |
| Install path    | CLI `bearclaw setup` + `bearclaw doctor`, plus a web first-run wizard     |
| Backup / move   | `bearclaw export` / `bearclaw import`                                     |
| `/setup` skill  | Deleted (`.claude/skills/setup/`, `.agents/skills/setup/`)                |
| Config store    | New separate database `~/.bearclaw/bearclaw.db`, mode 0600                |
| `.env`          | Dropped entirely; secrets are rows, the environment still overrides them  |
| Source of truth | The database. Skills and context are mirrored into `var/cache/`           |
| Agent writes    | Context changes go through MCP `context_write`, never through file writes |
| `~/.bearclaw`   | No longer a git repo; `.git` retired into `legacy-*/` by the importer     |

## Schema v1

```sql
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, secret INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE agents (folder TEXT PRIMARY KEY, name TEXT NOT NULL, channels TEXT NOT NULL DEFAULT '{}', container_config TEXT, heartbeat TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE context_files (scope TEXT NOT NULL CHECK (scope IN ('shared','agent')), folder TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (scope, folder, name));
CREATE TABLE skills (name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '', source_path TEXT, installed_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE skill_files (skill TEXT NOT NULL REFERENCES skills(name) ON DELETE CASCADE, relpath TEXT NOT NULL, content BLOB NOT NULL, mode INTEGER NOT NULL DEFAULT 420, updated_at TEXT NOT NULL, PRIMARY KEY (skill, relpath));
CREATE TABLE skill_sources (dir TEXT PRIMARY KEY, added_at TEXT NOT NULL);
CREATE TABLE mcp_servers (name TEXT PRIMARY KEY, config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
CREATE TABLE model_catalog (id INTEGER PRIMARY KEY CHECK (id = 1), catalog TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE workflow_definitions (slug TEXT PRIMARY KEY, definition TEXT NOT NULL, updated_at TEXT NOT NULL);
```

Notes that shaped the tables:

- `agents.channels` is a JSON `Record<channelKey, StoredChannel>`; a row with
  `{}` is an unwired folder, which replaces the old "directory with no registry
  entry" state.
- Setting keys are environment variable names, which is what makes the
  precedence work: environment beats database beats code default. Internal keys
  live under `bearclaw.` (`password_hash`, `onboarded`, `imported_at`,
  `legacy_dir`) and are never exported to the environment.
- `BEARCLAW_HOME`, `NODE_ENV`, `BEARCLAW_HTTP_PORT`, `BEARCLAW_HTTP_HOST` and
  `BEARCLAW_BACKEND_URL` stay environment-only: they are read before, or
  outside, the database.
- Workflow definitions are rows; the `workflows` index table in
  `var/messages.db` keeps runtime state (`enabled`, `last_run_*`) and the
  `file_path` / `file_hash` columns were dropped.

## Module layout

`src/store/`: `paths` (every path derived from `BEARCLAW_HOME`, no throws),
`config-db` (open, chmod 0600, pragmas, migrations), `migrations`
(`PRAGMA user_version`, refuses a database newer than the code), `settings`
(get/set/list, secret flag, `loadSettingsIntoEnv`, scrypt password),
`agents`, `context`, `skills`, `mcp`, `models`, `workflows`, `materialize`
(the `var/cache/` mirrors and the per-agent symlinks), `import-legacy`,
`bootstrap`, `testing`.

The entry point splits to kill the import-time environment problem:
`src/index.ts` runs `bootstrap()` and then dynamically imports `src/app.ts`,
which holds the old `main()`. `src/config.ts` no longer loads dotenv and no
longer throws when `DEFAULT_MODEL` is unset; the run paths raise instead, with
a message pointing at setup.

Materialization: skills are rebuilt into a temp directory and swapped in
atomically, preserving each file's mode; context is written per file with
tmp+rename and a full rebuild on boot that prunes rowless files. Each agent
folder gets `.claude/skills` and `context` symlinks into `var/cache/`, and a
`PreToolUse` hook denies agent writes anywhere under that tree.

## CLI and wizard

`bearclaw <command>` (`src/cli.ts` + `src/cli/*`, `node:util parseArgs`, no new
dependencies):

- `setup`: prerequisites, bootstrap, legacy import, Claude token, model,
  assistant name and timezone, web password, starter context from
  `templates/`, mirrors, launchd plists rendered from `launchd/*.plist`,
  build, service start, onboarding flag. Idempotent; `--yes`, `--generate`,
  `--skip-build`, `--skip-web`, `--skip-services`.
- `doctor`: one line per check (node, `claude` CLI, database presence and
  mode, auth, model, password, auth secret, WhatsApp credentials, Telegram
  token, both launchd labels, both HTTP ports, the shared DB health checks,
  mirror counts, per-agent symlinks, leftover legacy directories). Exit 1 on
  any failure.
- `export` / `import`: a `0600` tarball of the config database plus channel
  credentials and a manifest, with a loud "contains secrets" warning; import
  refuses to clobber an existing database without `--force` and then runs the
  machine-local half of setup.
- `migrate-fs`: the legacy importer, `--dry-run` / `--force` / `--keep-files`.
- `config get|set|unset|list`, `config mcp …`, `config catalog …`,
  `workflows list|export|import`, `whatsapp-auth`.

Web: `GET /api/setup/status` is public, `POST /api/setup/password` works only
while the install is not onboarded, the rest of the wizard uses the normal
authed routes. `web/middleware.ts` redirects everything to `/setup` until
onboarding finishes, and 404s `/setup` afterwards for a logged-out visitor.
The wizard walks password → name/model/timezone → Claude auth → USER/SOUL/
IDENTITY editors → channels → complete, then restarts the process so the new
settings reach `process.env`. Admin > Settings is the post-wizard editor for
settings and MCP servers.

## Legacy importer

One transaction, renames after commit, idempotent. It reads `.env` through
`dotenv.parse` (the only remaining use of the dependency), the flat or nested
`registered_agents.json`, `agents/{folder}/*.md`, `context/*.md`,
`skills/**` (with modes), `config/mcp.json`, `model-catalog.json`,
`workflows/*.json` and `var/initial-password`; moves non-markdown agent files
into `var/agents/{folder}/`; then moves every legacy path into
`~/.bearclaw/legacy-YYYYMMDD/`, including `.git` and `.gitignore`. Nothing is
deleted, and nothing ever runs `git init` again.

## Phases as shipped

| P   | Commit    | Scope                                                                      |
| --- | --------- | -------------------------------------------------------------------------- |
| P1  | `bae4ed5` | Config DB, settings bootstrap, entry split, password hash, CLI skeleton    |
| P2  | `d8b3a7e` | Agents registry and context files into the DB; `context_*` MCP tools       |
| P3  | `0cdad95` | Skills into the DB, mirrored into `var/cache/skills`                       |
| P4  | `883ee08` | Workflows, MCP servers and the model catalog into the DB                   |
| P5  | `32e0dd2` | `bearclaw setup`, `doctor`, `export`, `import`; templates; plist rendering |
| P6  | `7ae0798` | Web first-run wizard and the settings admin page                           |
| P7  | this one  | Docs, plus two robustness fixes found in the P6 end-to-end run             |

P7's fixes: a rejected Telegram start (a wrong `TELEGRAM_BOT_TOKEN` answers
grammY's `getMe` with HTTP 401) is logged and skipped instead of taking the
boot down, and `GET /api/admin/context/file` answers 404 rather than 400 for a
row that does not exist, which is the normal first-run case for the wizard's
prefill.

## Known follow-ups

- `customize`, `debug` and the `add-*` skills still describe `.env` files and
  container-era steps. They carry a stale banner rather than a rewrite.
- SDK transcripts under `~/.claude/projects/` are outside export bundles, so a
  restored machine starts its sessions fresh.
- Secrets are stored in the clear in `bearclaw.db` (mode 0600) and reach the
  agent through `process.env`, unchanged from the `.env` era.
