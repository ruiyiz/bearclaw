# NanoClaw Specification

A personal Claude assistant accessible via chat platforms (WhatsApp, Telegram, iMessage) and Gmail, with persistent memory per agent, scheduled handlers, event-driven handlers, and shared context.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Folder Structure](#folder-structure)
3. [Configuration](#configuration)
4. [Memory System](#memory-system)
5. [Dream Cycle](#dream-cycle)
6. [Session Management](#session-management)
7. [Message Flow](#message-flow)
8. [Handlers](#handlers-scheduled--event-driven)
9. [MCP Servers](#mcp-servers)
10. [Deployment](#deployment)
11. [Security Considerations](#security-considerations)
12. [Troubleshooting](#troubleshooting)

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

| Component  | Technology                                 | Purpose                                            |
| ---------- | ------------------------------------------ | -------------------------------------------------- |
| WhatsApp   | `@whiskeysockets/baileys`                  | WhatsApp Web protocol                              |
| Telegram   | `grammy`                                   | Bot API + agent-swarm bot pool                     |
| iMessage   | `imsg` CLI + file tail                     | macOS Messages                                     |
| Email      | `gog` CLI                                  | Gmail polling and sending                          |
| Storage    | `better-sqlite3` + `sqlite-vec`            | Messages, handlers, event bus, FTS5, vector chunks |
| Embeddings | OpenAI `text-embedding-3-small` (1536-dim) | Memory chunk embeddings; optional                  |
| Agent      | `@anthropic-ai/claude-agent-sdk`           | In-process Claude execution                        |
| TUI        | `ink` + `react`                            | Status terminal UI                                 |
| Runtime    | Node.js 20+                                | Single host process                                |

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
│   │   ├── ENGRAM.md                # Curated long-term memory (dream output, proposed)
│   │   ├── memory/YYYY-MM-DD.md     # Daily memory log
│   │   ├── dreams/YYYY-MM-DD.md     # Reflective diary (dream output, proposed)
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
ASSISTANT_NAME; // trigger word, default "Andy"
DISPLAY_NAME; // outbound prefix, defaults to ASSISTANT_NAME
(TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_POOL, TELEGRAM_ONLY);
IMESSAGE_ENABLED;
(NANOCLAW_HOME, STORE_DIR, CONTEXT_DIR, AGENTS_DIR, DATA_DIR);
MAIN_AGENT_FOLDER = 'main';
AGENT_TIMEOUT; // default 300_000 ms
DREAM_HOUR; // default 4 (4 AM local); also when daily session reset fires
TIMEZONE; // process.env.TZ or system default
TRIGGER_PATTERN; // RegExp ^@<ASSISTANT_NAME>\b
(HEARTBEAT_HANDLER_PREFIX, HEARTBEAT_PROMPT);
(EMAIL_HANDLER_PREFIX, EMAIL_DEFAULT_INTERVAL);
```

### Authentication

`~/.nanoclaw/.env` should contain one of:

```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...   # Subscription
ANTHROPIC_API_KEY=sk-ant-api03-...         # Pay-per-use
```

Channel tokens (optional): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_POOL`, `IMESSAGE_ENABLED=true`.

Embedding key (optional but recommended): `OPENAI_API_KEY`. Without it, vector retrieval is disabled and `memory_search` falls back to FTS5-only.

### Changing the Assistant Name

Set `ASSISTANT_NAME=Bot` in `~/.nanoclaw/.env`. This shifts both the trigger pattern (`@Bot ...`) and the outbound prefix (`Bot:`).

---

## Memory System

NanoClaw separates **shared context** from **per-agent identity** and **rolling memory**.

| Layer              | Location                                           | Read by                          | Written by                         | Purpose                                  |
| ------------------ | -------------------------------------------------- | -------------------------------- | ---------------------------------- | ---------------------------------------- |
| **Shared context** | `~/.nanoclaw/context/{AGENTS,SOUL,USER,MEMORY}.md` | All agents                       | Main only (MEMORY)                 | Stable durable facts, persona, user info |
| **Identity**       | `~/.nanoclaw/agents/{folder}/IDENTITY.md`          | That agent                       | Hand-edited                        | Per-agent role/personality               |
| **Daily log**      | `~/.nanoclaw/agents/{folder}/memory/YYYY-MM-DD.md` | That agent (via `memory_search`) | `memory_write` MCP tool            | Running notes, decisions, context        |
| **Conversations**  | `~/.nanoclaw/agents/{folder}/conversations/`       | That agent                       | `memory-flusher.ts` on session end | Full archived transcripts                |
| **Working files**  | `~/.nanoclaw/agents/{folder}/...`                  | That agent                       | The agent (Bash/Write/Edit)        | Notes, research, scratch                 |

**Context loading.** The agent runner concatenates the shared context files plus the agent's `IDENTITY.md` and appends them to the system prompt before invoking `query()`. The `SessionStart` hook also injects the last two days of `memory/*.md` so the agent boots with recent state.

**Memory search.** `memory_write` appends to today's daily log, indexes the file into a SQLite FTS5 table, and chunks it for vector storage. `memory_search` performs **hybrid retrieval** — file-level BM25 (FTS5) blended with chunk-level cosine similarity (`sqlite-vec`) via Reciprocal-Rank Fusion (k=60). Embeddings are generated by OpenAI `text-embedding-3-small` (1536-dim) when `OPENAI_API_KEY` is set; otherwise the system gracefully falls back to FTS5-only.

**Main-agent privileges.** Only `main` writes to shared `context/MEMORY.md`. Other agents can only write to their own agent folder.

---

## Dream Cycle

**Status:** Implemented. See `src/dream/` and `src/agent/embedder.ts`.

A nightly background process per agent that distills rolling memory into a curated long-term file (`ENGRAM.md` — the neuroscience term for a persisted memory trace) and writes a reflective diary entry. Modeled on OpenClaw Dreaming (three-phase Light/REM/Deep with weighted scoring), Claude Code Auto Dream (between-session consolidation, relative-to-absolute date conversion, size cap), and Hermes Agent (bounded memory forces curation). Goal: replace "last 2 days of `memory/*.md`" as the sole long-horizon recall path with a smaller, higher-signal `ENGRAM.md` plus an inspectable diary.

The daily session reset is **bundled** with the dream cycle: the dream handler is the only scheduled path that resets sessions (see [Session Management](#session-management)).

### Pipeline

```
        ┌──────────────────────────────────────────────┐
        │  Step 0: Reset                               │
        │  memory-flusher archives transcript,         │
        │  clears sessionId in sessions.json           │
        └──────────────────────────────────────────────┘
                              │
   recent memory/*.md  conversations/   FTS+vector recall scores
            │                │                    │
            ▼                ▼                    ▼
        ┌──────────────────────────────────────────────┐
        │  Light  (deterministic — no LLM)             │
        │  ingest, chunk, Jaccard-dedupe, stage rows   │
        │  → dream_candidates (SQLite)                 │
        └──────────────────────────────────────────────┘
                              │
                              ▼
        ┌──────────────────────────────────────────────┐
        │  REM    (subagent run, read-only tools)      │
        │  cluster themes, mark contradictions,        │
        │  write theme tags + reinforcement weights    │
        └──────────────────────────────────────────────┘
                              │
                              ▼
        ┌──────────────────────────────────────────────┐
        │  Deep   (deterministic — no LLM)             │
        │  score every candidate, apply 3 gates,       │
        │  rehydrate from live daily files,            │
        │  promote winners → ENGRAM.md                 │
        └──────────────────────────────────────────────┘
                              │
                              ▼
        ┌──────────────────────────────────────────────┐
        │  Narrate (subagent run, write-restricted)    │
        │  short reflective entry (80–180 words)       │
        │  → dreams/YYYY-MM-DD.md                      │
        └──────────────────────────────────────────────┘
                              │
                              ▼
        ┌──────────────────────────────────────────────┐
        │  Main-only: Shared promotion + report        │
        │  read every agent's ENGRAM.md, score,        │
        │  promote → context/MEMORY.md,                │
        │  send Hypnopompic Report to default channel  │
        └──────────────────────────────────────────────┘
```

LLM cost is bounded: two subagent runs per agent per night (REM + Narrate), plus one extra Narrate-style run on `main` for the Hypnopompic Report. Light, Deep, and shared-promotion scoring are pure code so they are reproducible and auditable.

### Trigger

A built-in handler `dream-{folder}` analogous to `heartbeat-{folder}`. Cron-only — fires once daily at `DREAM_HOUR` local time (default 4 AM). The handler is the sole scheduled path for both session reset and dream consolidation.

Skip the dream phases (but still perform the reset) if there is insufficient new content:

- `< DREAM_MIN_NEW_ENTRIES` new daily-log entries since last dream (default 5)

There is no manual MCP trigger. Operators can force a run for debugging via a one-shot script (out of band of the agent surface). Agents cannot trigger their own dream cycles — the dream is off-line maintenance, not an in-session capability.

### Substrate

Per agent (`agents/{folder}/`):

| Source                         | Window                                 | Purpose                                    |
| ------------------------------ | -------------------------------------- | ------------------------------------------ |
| `memory/YYYY-MM-DD.md`         | last `DREAM_LOOKBACK_DAYS` (default 7) | Short-term ingestion                       |
| `conversations/*.md` summaries | last `DREAM_LOOKBACK_DAYS`             | Episodic context                           |
| FTS5 + vector retrieval scores | rolling                                | Per-snippet `relevance` signal (see below) |
| Existing `ENGRAM.md`           | full                                   | Avoid re-promoting already-curated facts   |

The `relevance` signal depends on the planned vector-index work (see [Memory System](#memory-system) future enhancements). Until that lands, `relevance` falls back to FTS5 BM25 score.

### Phases

#### Light — ingest & dedupe

1. Read each daily log in the lookback window; split on `##` headings into snippet candidates.
2. Normalize whitespace, strip code fences, lowercase for hashing.
3. Compute Jaccard similarity against (a) existing `dream_candidates` rows from prior runs and (b) each other; collapse ≥0.85 matches into a single row with `support_count++` and merged `source_paths`.
4. Insert/update rows in `dream_candidates` (schema below). Never writes to `ENGRAM.md` or `MEMORY.md`.

#### REM — cluster & reflect

A subagent run with `cwd=~/.nanoclaw/agents/{folder}/` and a **fully restricted tool surface**: no tools at all. The candidate set is passed in via the prompt; no filesystem traversal, no `memory_search`, no `Read`. Reasoning:

- Determinism: REM produces the same theme assignments given the same candidate set.
- Confined blast radius: a hallucinated theme can only mistag a candidate, not invent unsupported source content.

System prompt instructs the subagent to:

- Group candidates into themes; emit `theme_tags` per row.
- Flag contradictions (`contradicts_id`) and reinforcements (`reinforces_id`).
- Output a single JSON document; runner parses and writes back to SQLite. No direct DB access from the subagent.

#### Deep — score, gate, promote

Deterministic. For each candidate compute the score `s ∈ [0,1]`:

| Signal            | Weight | Definition                                                     |
| ----------------- | -----: | -------------------------------------------------------------- |
| `frequency`       |   0.24 | log1p(`support_count`) normalized over the run                 |
| `relevance`       |   0.30 | mean retrieval score across hits in last `DREAM_LOOKBACK_DAYS` |
| `query_diversity` |   0.15 | distinct `chat_id` ∪ `handler_id` that retrieved the snippet   |
| `recency`         |   0.15 | exp(−days_since_last_seen / `DREAM_RECENCY_HALFLIFE`)          |
| `consolidation`   |   0.10 | distinct days the snippet appeared on                          |
| `richness`        |   0.06 | `len(theme_tags)` capped at 5                                  |

Gates (all must pass):

| Gate           | Default | Reason                                                 |
| -------------- | ------: | ------------------------------------------------------ |
| `minScore`     |    0.55 | Quality floor                                          |
| `minSupport`   |       2 | Avoid promoting one-off remarks                        |
| `minDiversity` |       2 | Avoid context-bound facts dressed up as general truths |

Before writing, **rehydrate** each surviving snippet: re-read the source path; if the source was deleted or no longer contains the snippet text, drop the candidate (so a user manually deleting a daily log entry is honored).

Promotion target for every agent: per-agent `ENGRAM.md`. Shared `context/MEMORY.md` is **not** written here; that is handled by main's shared-promotion step below.

#### Narrate — diary entry

Subagent run (read-only on memory dir, can write only to `dreams/YYYY-MM-DD.md`). Writes a single 80–180-word reflective entry summarizing what was promoted and why. Human-readable; not used as input for retrieval.

#### Shared promotion (main agent only)

After main's own Light/REM/Deep/Narrate complete, an additional deterministic step:

1. Read every registered agent's `ENGRAM.md` (including main's own, just promoted).
2. Build a candidate set across all agents; identical/near-identical lines (Jaccard ≥ 0.85) collapse into one candidate with `support_count` = number of agents carrying it.
3. Score using the same six signals; `query_diversity` is recomputed as **distinct agents** rather than distinct chats.
4. Apply the same gates. Rehydrate against each source `ENGRAM.md` before writing.
5. Promote winners into `context/MEMORY.md` (200-line cap; cap-overflow demotes lowest-scored line).

This replaces the previous `dream_promotion_proposed` event mechanism. Non-main agents do nothing special to make their content eligible for shared promotion — main's dream simply reads their `ENGRAM.md` files. Cross-agent read access is granted to main's dream-handler code only; the REM and Narrate subagents (which run with main's `cwd`) do not need to traverse other agents' folders, since aggregated content is passed in via prompt.

#### Hypnopompic Report (main agent only)

Final subagent run on main, write-restricted to sending one channel message. Composes a short summary message and sends it via `send_message` to main's default chat:

- Counts: engrams promoted per agent, MEMORY.md lines added/demoted, contradictions resolved.
- A 2–4 sentence narrative reflection drawing from main's own `dreams/YYYY-MM-DD.md` and the cross-agent themes.
- Date-stamped subject line, e.g. `Hypnopompic Report — 2026-05-04`.

The report is the only dream-cycle output the user sees by default; everything else is on-disk for inspection on demand.

### Outputs

| Path                                   | Producer                          | Purpose                                                       | Cap                                              |
| -------------------------------------- | --------------------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| `agents/{folder}/ENGRAM.md`            | Deep phase                        | Curated per-agent long-term memory                            | 200 lines; on overflow demote lowest-scored line |
| `agents/{folder}/dreams/YYYY-MM-DD.md` | Narrate phase                     | Inspectable diary, one file per dream run                     | none (per-day file)                              |
| `context/MEMORY.md`                    | Shared-promotion step (main only) | Shared user-level facts, sourced from all agents' `ENGRAM.md` | 200 lines (existing)                             |
| Channel message: Hypnopompic Report    | Main only, end of cycle           | User-facing daily summary                                     | one message per dream                            |
| `dream_candidates` SQLite table        | Light/REM phases                  | Working set across runs                                       | TTL-pruned at `DREAM_LOOKBACK_DAYS × 2`          |

### Hygiene rules

- **Absolute dates only.** Before promotion, rewrite "yesterday", "this week", "next Tuesday" to absolute dates relative to the dream run's clock.
- **Rehydrate before write.** Source-of-truth check against the live daily log; deleted = dropped.
- **Bounded targets.** `ENGRAM.md` and `MEMORY.md` capped at 200 lines; overflow demotes lowest-scored line, never refuses a higher-scored write.
- **Append-only diary.** `dreams/` is never rewritten by the agent; user can delete files but the system does not.
- **Idempotent reruns.** Re-running a dream for the same day must converge: `support_count` deduplication + score-gate ensures no double-promotion.

### Multi-agent boundaries

| Action                                            | `main`                           | Non-main |
| ------------------------------------------------- | -------------------------------- | -------- |
| Read own `memory/`, `conversations/`, `ENGRAM.md` | yes                              | yes      |
| Write own `ENGRAM.md`, `dreams/`                  | yes                              | yes      |
| Read other agents' `ENGRAM.md`                    | yes (shared-promotion step only) | no       |
| Write shared `context/MEMORY.md`                  | yes (shared-promotion step only) | no       |
| Send the Hypnopompic Report                       | yes                              | no       |

Cross-agent reads are limited to main's deterministic shared-promotion step in dream-handler code; the REM and Narrate subagents never traverse other agents' folders directly. The IPC watcher continues to reject cross-agent writes from non-main agents the same way it rejects cross-agent `send_message` (see [Security Considerations](#security-considerations)).

### Storage schema

```sql
CREATE TABLE dream_candidates (
  id              INTEGER PRIMARY KEY,
  agent_folder    TEXT    NOT NULL,
  snippet         TEXT    NOT NULL,
  snippet_hash    TEXT    NOT NULL,
  source_paths    TEXT    NOT NULL,    -- JSON array
  first_seen      INTEGER NOT NULL,    -- unix sec
  last_seen       INTEGER NOT NULL,
  support_count   INTEGER NOT NULL DEFAULT 1,
  distinct_days   INTEGER NOT NULL DEFAULT 1,
  retrieval_hits  INTEGER NOT NULL DEFAULT 0,
  retrieval_score REAL    NOT NULL DEFAULT 0,
  query_chats     TEXT    NOT NULL DEFAULT '[]',   -- JSON array of chat/handler ids
  theme_tags      TEXT    NOT NULL DEFAULT '[]',   -- JSON array, set by REM
  contradicts_id  INTEGER,
  reinforces_id   INTEGER,
  score           REAL,                            -- final Deep-phase score
  promoted_at     INTEGER,                         -- null until promoted
  promoted_to     TEXT,                            -- 'ENGRAM' | 'MEMORY' | null
  UNIQUE (agent_folder, snippet_hash)
);

CREATE INDEX dream_candidates_agent_score ON dream_candidates(agent_folder, score DESC);
CREATE INDEX dream_candidates_last_seen   ON dream_candidates(last_seen);
```

A separate `dream_runs(id, agent_folder, started_at, finished_at, status, light_count, rem_count, deep_promoted, error)` table for observability.

### Configuration

New entries in `src/config.ts`:

```typescript
DREAM_ENABLED; // default false; opt-in per the OpenClaw precedent
DREAM_HOUR; // default 4 (4 AM local); shared with daily session reset
DREAM_LOOKBACK_DAYS; // default 7
DREAM_MIN_NEW_ENTRIES; // default 5; below this, reset still fires but phases are skipped
DREAM_RECENCY_HALFLIFE; // default 3 (days)
DREAM_MIN_SCORE; // default 0.55
DREAM_MIN_SUPPORT; // default 2
DREAM_MIN_DIVERSITY; // default 2
DREAM_ENGRAM_LINE_CAP; // default 200
DREAM_REPORT_CHANNEL; // optional; defaults to main's registered chat
```

Per-agent override in `registered_agents.json`: `"dream": { "enabled": true }` — same shape as the existing `heartbeat` block. The hour is global because it is bundled with the global daily reset.

### MCP tool surface

The dream cycle adds **no new MCP tools**. Agents do not trigger dreams, do not propose cross-agent promotions, and do not introspect dream state through dedicated tools. They read `ENGRAM.md` and `dreams/YYYY-MM-DD.md` directly via the existing `Read` tool when content is needed. Operator debugging of the `dream_runs` table is out-of-band via `sqlite3` on the host, not via an MCP surface.

### Dependencies

1. **Vector index over `memory/` and `conversations/`** — implemented via `sqlite-vec` virtual table `memory_vec`, populated by `src/agent/memory-embed.ts`. Embeddings via OpenAI `text-embedding-3-small`. When `OPENAI_API_KEY` is unset, the dream falls back to neutral relevance and FTS5-only memory_search.
2. **Daily memory-flusher producing `conversations/` summaries** — `src/agent/memory-flusher.ts`.
3. **Subagent invocation with restricted tool surfaces** — `src/dream/subagent.ts` invokes the SDK directly with no MCP server and a caller-specified `allowedTools` list. REM uses `[]` (no tools), Narrate uses `['Write']`, Hypnopompic Report uses `[]`.

### Failure modes & mitigations

| Risk                                                                      | Mitigation                                                                                                                                                            |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory poisoning (a malicious or confused message becomes a curated fact) | Gates require `minSupport ≥ 2` and `minDiversity ≥ 2`; rehydrate-before-write                                                                                         |
| Semantic drift (rewrite of `ENGRAM.md` corrupts a fact)                   | Deep phase appends only; never edits prior `ENGRAM.md` lines except for the cap-overflow demotion                                                                     |
| Confabulation in the REM subagent                                         | REM has read-only tools and emits structured JSON, never writes prose into curated stores                                                                             |
| Stale relative dates                                                      | Mandatory absolute-date rewrite before promotion                                                                                                                      |
| Runaway compute                                                           | Two subagent runs per agent per night (REM + Narrate), plus one Hypnopompic Report run on main; deterministic scoring elsewhere                                       |
| Privilege escalation across agents                                        | Non-main never reads or writes outside its folder; main's cross-agent reads happen only in deterministic dream-handler code, not in subagent prompts                  |
| Cross-agent contradiction in shared MEMORY.md                             | Shared-promotion step gates on `minSupport ≥ 2` recomputed across agents; conflicting lines in different agents' `ENGRAM.md` cancel out unless one dominates on score |

### Resolved design decisions

1. **Two curated files.** Per-agent `ENGRAM.md` separate from shared `context/MEMORY.md`. Dream's Deep phase writes the former; main's shared-promotion step writes the latter.
2. **Cron-only trigger.** Daily at `DREAM_HOUR`, bundled with the session reset. `DREAM_MIN_NEW_ENTRIES` only gates whether the post-reset phases run.
3. **REM tool surface stays read-only on the prompted candidate set.** No `memory_search` access — the marginal benefit (cross-window contradiction detection) is achievable deterministically in the Deep phase, while the cost (non-determinism, hallucination blast radius) is real.
4. **Cross-agent promotion is centralized in main.** Main's dream reads every agent's `ENGRAM.md` in a deterministic shared-promotion step and writes `context/MEMORY.md` directly. No event-based proposal mechanism. The Hypnopompic Report sent to main's default channel is the user-facing surface.
5. **Ambition ceiling: curated markdown.** No LoRA-adapter / fine-tuning track in scope.

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

**Resets.** Sessions are cleared via exactly two paths:

- **Daily, bundled with the dream cycle.** The `dream-{folder}` handler fires at `DREAM_HOUR` (default 4 AM); its first step is to archive + reset the session, after which it proceeds with the dream phases. There is no standalone session-reset loop.
- **On `/new` from the user.** Manual reset; does not trigger a dream.

There is no idle-based reset.

Before a reset (in either path), `memory-flusher.ts` archives the transcript into `conversations/` and appends a session summary to today's `memory/YYYY-MM-DD.md`. See [Dream Cycle](#dream-cycle-proposed) for the bundled flow.

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

| Shape        | Storage                                       | Triggered by                                                      |
| ------------ | --------------------------------------------- | ----------------------------------------------------------------- |
| Cron         | `cron` field set                              | `events/scheduler.ts` emits `cron_trigger` when `next_run <= now` |
| One-shot     | `next_run` set, `cron` null, `max_triggers=1` | Same as cron                                                      |
| Event-driven | `event_type != 'cron_trigger'`, `filter` JSON | `events/bus.ts` matches event type + filter                       |

### Lifecycle

1. **Register** — `register_handler` (event-driven), `schedule_task` (cron / one-shot), or built-in (heartbeat, email_received).
2. **Fire** — `events/bus.ts` runs the handler in a fresh agent invocation. Context mode is either `agent` (shared session, can use payload's `session_key`) or `isolated` (fresh session every time).
3. **Log** — duration, status, result/error written to `handler_logs`.
4. **Chain** — every handler completion emits `handler_complete`; agent runs emit `agent_complete`. These can drive subsequent handlers.

### Built-in event types

| Event                                         | Source                        | Payload                                                             |
| --------------------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `cron_trigger`                                | `events/scheduler.ts`         | `{ handler_id }`                                                    |
| `email_received`                              | `integrations/email.ts`       | `{ group_folder, message_id, thread_id, from, subject, body, ... }` |
| `subprocess_exit` / `subprocess_notification` | `agent/subprocess-manager.ts` | `{ sessionId, exitCode, ... }`                                      |
| `agent_complete`                              | `agent/runner.ts`             | `{ group_folder, trigger_type, status, duration_ms }`               |
| `handler_complete`                            | `events/bus.ts`               | `{ handler_id, group_folder, status, result_summary }`              |

Custom events can be emitted by agents via `mcp__nanoclaw__emit_event`.

### Heartbeat

When an agent has `heartbeat: { interval, model?, quiet? }` set in `registered_agents.json`, NanoClaw maintains a recurring `heartbeat-{folder}` handler that wakes the agent on the configured interval (skipped during the optional `quiet` window).

### Email

When an agent has `email: { address, interval? }`, a poll loop fetches unread Gmail to that address, emits `email_received`, and the matching handler runs the agent. The agent can call `reply_email` to thread a response.

---

## MCP Servers

### `nanoclaw` MCP (built-in, see `src/agent/ipc-mcp.ts`)

Created per-agent-call with the agent's identity. Tools:

| Tool                                                                 | Purpose                                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send_message`                                                       | Outbound channel message (text and/or media)                                                                                                                                                                                     |
| `schedule_task`                                                      | Cron or one-shot handler                                                                                                                                                                                                         |
| `register_handler`                                                   | Event-driven handler                                                                                                                                                                                                             |
| `list_handlers`, `pause_handler`, `resume_handler`, `cancel_handler` | Handler management                                                                                                                                                                                                               |
| `emit_event`                                                         | Custom event emission                                                                                                                                                                                                            |
| `register_agent`                                                     | Register a new chat as an agent (main only)                                                                                                                                                                                      |
| `reply_email`                                                        | Thread a Gmail reply                                                                                                                                                                                                             |
| `memory_write`, `memory_search`                                      | Daily log + FTS lookup                                                                                                                                                                                                           |
| `subprocess_start/read/write/poll/kill/list`                         | PTY subprocess driver                                                                                                                                                                                                            |
| `image_generate`                                                     | Image generation via OpenAI gpt-image-2 or Google nano-banana (gemini-2.5-flash-image). Gated on `OPENAI_API_KEY` or `GOOGLE_API_KEY`. Fire-and-forget by default; writes file to `agents/{folder}/media/` and delivers via IPC. |

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

| Issue                          | Cause                                                             | Fix                                                                   |
| ------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| No response to messages        | Service not running                                               | `launchctl list \| grep nanoclaw`                                     |
| Agent error: invalid API key   | Missing/wrong `.env`                                              | Check `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`                |
| Session not continuing         | Daily/idle reset, or transcript deleted                           | Inspect `~/.nanoclaw/data/sessions.json` and `~/.claude/projects/`    |
| WhatsApp QR expired            | Auth state stale                                                  | `bun run auth` (or delete `~/.nanoclaw/store/auth/` and re-run setup) |
| iMessage messages not arriving | `imsg watch` not appending to `~/.nanoclaw/data/imsg-watch.jsonl` | Verify Full Disk Access; rerun `scripts/setup-imessage.sh`            |
| Telegram silent                | Bot token missing or bot not added to chat                        | Check `TELEGRAM_BOT_TOKEN`; `/chatid` in the chat to grab the JID     |

### Log locations

- `logs/nanoclaw.log` — host stdout
- `logs/nanoclaw.error.log` — host stderr
- `~/.nanoclaw/agents/{folder}/logs/agent-*.log` — per-run logs
- `~/.claude/projects/{encodedCwd}/{sessionId}.jsonl` — Claude Agent SDK transcripts
