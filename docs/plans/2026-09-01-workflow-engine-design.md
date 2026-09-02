# Workflow Engine Design

Replace heartbeat + handlers with one primitive: a **workflow**, a small
flowchart of typed nodes with explicit human-in-the-loop steps, run by a durable
step interpreter in the host process, and managed from a first-class
**Workflows** module in the web UI alongside Chat.

## Problem

Today a "workflow" is a `handlers` row: one prompt, one agent run, one 500-char
log line. Heartbeat is the same thing with a special prompt and a quiet window.
What the codebase does not have shows up in the live handler prompts:

| Gap                                                                                                                         | Evidence                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structure lives in prose. Branches, guards and side-effect ordering are enforced by the LLM's obedience, not by the system. | `feed-triage` is a six-step pipeline with a zero-unread branch, a "SEND GUARD" paragraph, and a rule that marking items read must happen only after a confirmed send.                                                                                                                                                                   |
| Deterministic steps cost an LLM turn.                                                                                       | `feeds count`, `feeds unread`, `gws gmail +send`, `feeds read`, `pipeline.mjs next` are all run by an agent with every tool enabled, `bypassPermissions`, 5-minute timeout.                                                                                                                                                             |
| No human-in-the-loop primitive.                                                                                             | No `ask_user`, no approval gate, no `canUseTool`. Workarounds: `newsletter-plan-ping` "ends its turn, the brainstorm continues as normal chat"; `feed-triage` reply-by-number rides on the `+main` email poll; `HEARTBEAT.md` says "seek clarifications from the user".                                                                 |
| Chaining is loose.                                                                                                          | `handler_complete` is emitted but nothing consumes it. `emit_event` has no authorization. Filters are exact-match JSON. No data flows between steps except through payloads or files on disk. No run identity, so `feed-triage-watchdog` is a second, uncoordinated handler that infers the previous run's outcome from a file's mtime. |
| Cross-agent workflows are three handlers and a JSON file.                                                                   | Newsletter: `newsletter-plan-ping` (main) → skill queue file → `newsletter-send` (coco) → `newsletter_queue_empty` event → `newsletter-empty-alert` (main).                                                                                                                                                                             |
| Observability is thin.                                                                                                      | `handler_logs.result` is 500 chars. `events` are purged after 24 h and take dependent logs with them. Admin UI: read-only list with pause/resume/delete, no create, no edit, no run view.                                                                                                                                               |
| No tests.                                                                                                                   | `bus.ts`, `scheduler.ts`, `heartbeat.ts` untested; `initDatabase()` hardcodes the path; `config.ts` throws without `DEFAULT_MODEL`.                                                                                                                                                                                                     |

What is worth keeping: `runContainerAgent` (one-shot agent run with model,
effort, session resume, timeout, streaming callbacks), the IPC message fan-out
(primary channel resolution, per-agent authorization), the `events` table as a
signal bus, `cron-parser` + `TIMEZONE`, the web broker/SSE plumbing, and the
Agent SDK's `outputFormat: { type: 'json_schema' }` (available in the pinned
SDK), which lets an LLM node hand typed data to a non-LLM node.

## Concepts

**Workflow**: a definition file. Name, owner agent (default agent for LLM
nodes), triggers, nodes, edges, policies. Lives at
`~/.bearclaw/workflows/<slug>.json`. Files are the source of truth so the owner
and the agent can edit them with ordinary file tools, they diff in git, and
they match how skills and context files already work.

**Run**: one execution of a workflow. Has an id, the trigger payload, a status
(`running | waiting | succeeded | failed | cancelled`), and a **context** object
that accumulates node outputs (`nodes.<id>.output`). Persisted to SQLite after
every step so a restart resumes where it left off.

**Node**: an execution unit. Most nodes are not LLM calls.

| Type         | What it does                                                                                                                                                                                             | Output               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `agent`      | One `runContainerAgent` call. Prompt template, agent folder override, model, effort, tool allowlist, timeout, optional `output_schema` (SDK structured output), session mode `fresh \| run \| chat`.     | text or typed JSON   |
| `shell`      | Command with cwd/env/timeout; stdout parsed as `json \| text \| lines`. Non-zero exit is a failure.                                                                                                      | parsed stdout        |
| `http`       | Request with method/url/headers/body.                                                                                                                                                                    | status + parsed body |
| `template`   | Mustache-style string rendering over the context. Replaces "ask the LLM to write HTML in this exact shape".                                                                                              | string               |
| `transform`  | Expression over the context producing a value.                                                                                                                                                           | any                  |
| `condition`  | Boolean expression; edges branch on `true` / `false`.                                                                                                                                                    | boolean              |
| `switch`     | Expression producing a label; edges branch on label.                                                                                                                                                     | string               |
| `send`       | Message or media to channel targets. Reuses the IPC fan-out (explicit jid, primary channel, or all). No LLM.                                                                                             | delivery report      |
| `human`      | Pauses the run and asks a person. Kinds: `approve` (approve/reject + comment), `choice` (labelled options), `input` (small form or free text). Targets, expiry, and on-timeout default are configurable. | the response         |
| `wait_event` | Pauses until an event matching a filter arrives, or times out.                                                                                                                                           | event payload        |
| `emit`       | Emits an event onto the bus.                                                                                                                                                                             | event id             |
| `delay`      | Durable sleep until a duration or wall-clock time.                                                                                                                                                       | none                 |
| `workflow`   | Runs another workflow as a sub-run and waits for it.                                                                                                                                                     | sub-run output       |
| `map`        | Runs one node (or sub-workflow) per item of an array, with a concurrency cap.                                                                                                                            | array of outputs     |

**Edge**: `from → to` with an optional `when`. Multiple unconditional outgoing
edges fan out in parallel; a node with several incoming edges joins (`all` by
default, `any` allowed). Edges may also key on `on: success | failure | timeout`
so a failing send can route to a notify node instead of failing the run.
Definitions must be acyclic; retry is a per-node setting, iteration is `map`.

**Trigger**: one or more per workflow. `cron` (expression, timezone, quiet
window, catch-up policy), `event` (type + filter, replaces `register_handler`),
`manual` (dashboard button, `/run <slug>` in chat, MCP tool), `webhook` (`POST
/api/hooks/<token>`, unauthenticated by token only), `at` (one-shot, replaces
`schedule_task run_at`).

**Policies** (workflow-level): `concurrency: skip | queue | replace` when a run
is already active (fixes heartbeat overlap), `alerts: { on_failure, on_missed }`
(replaces the watchdog pattern; `on_missed` fires when a cron run has not
succeeded within `expected_within` of its slot), `retention`.

The default remains one workflow, one agent: `owner` sets the agent for every
`agent`, `send` and `human` node unless a node overrides it. Cross-agent
workflows are the same file with per-node `agent` overrides.

## Definition format

```json
{
  "$schema": "bearclaw://workflow/v1",
  "name": "Feed triage",
  "slug": "feed-triage",
  "owner": "main",
  "triggers": [{ "type": "cron", "cron": "0 20 * * *" }, { "type": "manual" }],
  "policies": {
    "concurrency": "skip",
    "alerts": {
      "on_failure": "owner",
      "on_missed": { "expected_within": "2h" }
    }
  },
  "nodes": {
    "count": {
      "type": "shell",
      "cmd": "feeds count --exclude-category aggregators",
      "parse": "json"
    },
    "unread": {
      "type": "shell",
      "cmd": "feeds unread --json --newest --per-feed 3 --limit 15 --exclude-category aggregators",
      "parse": "json"
    },
    "any": { "type": "condition", "expr": "nodes.unread.output.length > 0" },
    "summarize": {
      "type": "agent",
      "model": "sonnet",
      "prompt": "Summarize each item in 1-2 sentences from its content field. Do not invent facts.\n{{json nodes.unread.output}}",
      "output_schema": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": { "type": "number" },
            "summary": { "type": "string" }
          },
          "required": ["id", "summary"]
        }
      }
    },
    "render": { "type": "template", "file": "templates/feed-digest.html" },
    "send": {
      "type": "shell",
      "cmd": "gws gmail +send --to {{env.OWNER_EMAIL}} --from ruiyizhang+main@gmail.com --subject {{q subject}} --body {{q nodes.render.output}} --html",
      "retry": { "max": 2, "backoff": "30s" }
    },
    "persist": {
      "type": "shell",
      "cmd": "cat > ~/.bearclaw/var/agents/main/feed-batch.json",
      "stdin": "{{json batch}}"
    },
    "mark_read": {
      "type": "shell",
      "cmd": "feeds read {{join nodes.unread.output.*.id ' '}}"
    },
    "caught_up": {
      "type": "shell",
      "cmd": "gws gmail +send --to {{env.OWNER_EMAIL}} --from ruiyizhang+main@gmail.com --subject 'Feeds: all caught up' --body '<p>All caught up.</p>' --html"
    },
    "reply": {
      "type": "human",
      "kind": "input",
      "to": ["email:main"],
      "prompt": "Reply with: save 1 4 · summarize 7 · dismiss 2 · next",
      "expires": "7d",
      "on_timeout": "skip"
    },
    "act": {
      "type": "agent",
      "prompt": "Apply the user's reply to the batch: {{nodes.reply.output}}\nBatch: {{json batch}}"
    },
    "failed": {
      "type": "send",
      "text": "Feed digest failed at {{failure.node}}: {{failure.error}}"
    }
  },
  "edges": [
    { "from": "count", "to": "unread" },
    { "from": "unread", "to": "any" },
    { "from": "any", "to": "summarize", "when": true },
    { "from": "any", "to": "caught_up", "when": false },
    { "from": "summarize", "to": "render" },
    { "from": "render", "to": "send" },
    { "from": "send", "to": "persist" },
    { "from": "persist", "to": "mark_read" },
    { "from": "mark_read", "to": "reply" },
    { "from": "reply", "to": "act" },
    { "from": "send", "to": "failed", "on": "failure" }
  ]
}
```

Compared with the prose version: the send guard is an edge, the "write the
empty batch file even when caught up" rule is a node that cannot be forgotten,
marking items read is structurally after a confirmed send, the LLM does exactly
one thing and returns typed data, and the watchdog is a one-line policy.

Templates use `{{ }}` with a handful of helpers (`json`, `q` for shell quoting,
`join`, `default`). Expressions run in a `node:vm` context with a frozen
`{ trigger, nodes, env, run }` object, no globals, and a 50 ms budget. This is
deliberately not a full language; anything that needs logic beyond a predicate
belongs in a `shell` or `agent` node.

## Engine

New module `src/workflows/`:

```
src/workflows/
├── schema.ts        zod schema for definitions; validation (acyclic, edge refs, unique ids)
├── store.ts         load/watch ~/.bearclaw/workflows/*.json; index rows in SQLite
├── engine.ts        run loop: ready-set computation, step execution, persistence, recovery
├── triggers.ts      cron ticker, event subscription, webhook, one-shot `at`
├── waits.ts         human / event / delay waits; resolution; notification delivery
├── expr.ts          vm-sandboxed expressions + template rendering
├── executors/       one file per node type, each `execute(node, ctx, run, signal) → Result`
└── migrate.ts       handlers rows + heartbeat config → workflow files (one time)
```

Tables (in `db.ts`):

```sql
workflows      (slug PK, name, owner, enabled, file_mtime, next_run_at, last_run_id, last_status)
workflow_runs  (id PK, slug, trigger_type, trigger_payload, status, context, started_at,
                finished_at, error, parent_run_id)
workflow_steps (id PK, run_id, node_id, attempt, status, input, output, error, log_path,
                agent_session_id, started_at, finished_at)
workflow_waits (id PK, run_id, node_id, kind, prompt, options, targets, notify_refs,
                expires_at, on_timeout, response, responded_via, resolved_at)
```

Step loop: a run advances by computing the set of nodes whose incoming edges
are all satisfied, executing them (parallel where the graph allows), writing
outputs into the context, and persisting. A node that returns a wait flips the
run to `waiting` and the loop stops touching it until the wait resolves. Large
outputs above a cap are spilled to `var/workflows/<run>/<node>.json` and the
context stores a reference.

Recovery: on boot, steps that were `running` are marked failed and retried per
their retry policy; waits are untouched; `delay` nodes re-arm from their
persisted deadline. Cron catch-up policy decides whether missed slots during
downtime run once, run all, or are skipped.

Reuse: the `agent` executor calls `runContainerAgent` with `outputFormat` when
a schema is set and with `workflow` metadata in the prompt frame so an agent
node can still call `send_message`, `emit_event` and the new workflow tools.
The `send` executor calls the same fan-out code as the IPC message watcher
(extracted from `index.ts` into a function that takes a source agent and a
target spec). The `events` table stays as the signal bus; `triggers.ts` and
`wait_event` are its only consumers.

## Human in the loop

A `human` node creates a wait, notifies, and parks the run. Three resolution
paths, all writing the same `workflow_waits.response`:

1. **Web inbox.** `/inbox` lists open waits with approve/reject buttons, choice
   buttons, or a form generated from the node's `fields`. Badge count in the
   top-level nav.
2. **Channel replies.** Telegram gets inline keyboard buttons whose callback
   data is `wf:<wait_id>:<choice>`. iMessage, WhatsApp and email get the prompt
   as text plus a short reply hint. The router checks for open waits targeting
   the inbound chat jid before dispatching to the agent; an exact match on a
   choice label or `yes/no/approve/reject` resolves the wait directly.
3. **Agent-mediated.** Anything that is not an exact match goes to the chat
   agent as usual, with the open waits for that chat injected into its turn
   context, and the agent calls `workflow_respond(wait_id, response)`. This is
   how free-text replies like "save 1 4, summarize 7" resolve an `input` wait
   without a parser per workflow.

Waits target people, not only the owner: `to: ["imsg:17"]` asks the kids a
question and branches on the answer.

Timeouts: `on_timeout` is `approve | reject | skip | fail | { value }`.
Expired waits are resolved by the engine with `responded_via: timeout`.

## Agent-facing tools

Replaces `schedule_task`, `register_handler`, `list_handlers`,
`pause_handler`, `resume_handler`, `cancel_handler`, and the
`current_handlers.json` snapshot.

| Tool                   | Purpose                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `workflow_list`        | Slugs, triggers, next run, last status, open waits.                                            |
| `workflow_upsert`      | Validate and write a definition file. Non-main agents may only write workflows they own.       |
| `workflow_run`         | Start a run with an optional payload.                                                          |
| `workflow_set_enabled` | Pause or resume triggers.                                                                      |
| `workflow_respond`     | Resolve a wait on behalf of the user in the current chat.                                      |
| `run_cancel`           | Cancel a run.                                                                                  |
| `emit_event`           | Unchanged, but now authorized: non-main agents may only emit types prefixed with their folder. |

One-shot reminders ("remind me tomorrow at 9") become
`workflow_upsert` with an `at` trigger and a single `send` node. The agent no
longer needs an LLM run to deliver a fixed string.

Heartbeat becomes a generated workflow per agent (`heartbeat-<folder>`): cron
trigger with the quiet window, one `agent` node whose prompt inlines
`HEARTBEAT.md`, model override, `concurrency: skip`. The `heartbeat` block in
`registered_agents.json` is dropped; the workflow file is the config.

## Web UI restructure

Top-level modules, one nav for all of them (sidebar on desktop, tab bar on
mobile):

| Module    | Pages                                                                                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat      | unchanged                                                                                                                                                                                                  |
| Workflows | `/workflows` list · `/workflows/[slug]` (graph, triggers, runs, definition editor) · `/workflows/[slug]/runs/[id]` (graph coloured by step status, live) · `/workflows/events` (bus log, moved from admin) |
| Inbox     | `/inbox` open human waits across all workflows, badge in nav                                                                                                                                               |
| Admin     | agents, skills, context, health, transcripts (handlers and heartbeat pages removed)                                                                                                                        |

Run view is the centre of the module: the same graph as the definition, nodes
coloured by step status, a side panel with input/output/error/log for the
selected node and a link to the agent transcript for `agent` nodes, and
controls for cancel, retry from a node, and respond to a wait. Live updates
arrive over the existing broker as a `wf:*` topic (`run.status`, `step.status`,
`wait.opened`, `wait.resolved`).

Editing in v1 is the definition JSON in CodeMirror (already a dependency) with
schema validation and a live read-only graph preview. Drag-and-drop editing is
a later phase; the file format is the contract either way. Graph rendering uses
`@xyflow/react` with `@dagrejs/dagre` for auto-layout, the one new UI
dependency worth taking. Lists and inbox are mobile-first; the canvas pans and
zooms on touch.

HTTP additions in `http.ts`:

```
GET    /api/workflows                    list with status
GET    /api/workflows/:slug              definition + index row
PUT    /api/workflows/:slug              validate + write file
DELETE /api/workflows/:slug
POST   /api/workflows/:slug/run
POST   /api/workflows/:slug/enabled      { enabled }
GET    /api/workflows/:slug/runs
GET    /api/runs/:id                     run + steps
POST   /api/runs/:id/cancel
POST   /api/runs/:id/retry               { from: nodeId }
GET    /api/waits                        open waits
POST   /api/waits/:id/respond
GET    /api/workflows/stream             SSE
POST   /api/hooks/:token                 webhook trigger (public, token-authed)
```

## Migration

`migrate.ts` runs once on first boot after the upgrade:

- Every `handlers` row becomes `~/.bearclaw/workflows/<id>.json` with a single
  `agent` node carrying the old prompt, `session: chat` for `context_mode:
agent`, the cron or event trigger, and `enabled` from `status`. Completed
  one-shots are skipped.
- `heartbeat` blocks become `heartbeat-<folder>.json`.
- `handler_logs` are left in place read-only until the retention window
  passes; the old tables are dropped in a later release.
- Once migrated, the owner can refactor the prose workflows into typed nodes
  one at a time. Nothing forces that; a one-node agent workflow keeps working.

Removed: `src/events/bus.ts`, `src/events/scheduler.ts`,
`src/events/heartbeat.ts`, the handler branches of `processTaskIpc`, the
handler MCP tools, `src/commands/jobs.ts` (replaced by `/workflows`), the admin
handlers and heartbeat pages, `HEARTBEAT_PROMPT` and `buildHeartbeatPrompt`.

## Phases

1. **Engine core.** Schema, store, engine, executors for `shell`, `agent`,
   `condition`, `switch`, `template`, `transform`, `send`, `emit`, `delay`,
   `human` (web resolution only), `wait_event`. Tables. Tests against an
   in-memory SQLite (make `initDatabase` accept a path) and a fake agent runner.
2. **Triggers and cut-over.** `cron`, `event`, `manual`, `at`, `webhook`.
   Migration script. Agent tools swapped. Old bus/scheduler/heartbeat deleted.
   `/workflows` slash command. Existing handlers keep running as one-node
   workflows.
3. **Web module.** Nav restructure, workflows list, run view with live graph,
   inbox, JSON editor with validation. Admin handlers/heartbeat pages removed.
4. **Channel-side human loop.** Telegram buttons, router wait matching,
   agent-mediated `workflow_respond`, alerts (`on_failure`, `on_missed`),
   `map`, sub-workflows.
5. **Editor.** Drag-and-drop node editing on the canvas. Optional.

Each phase ships on its own; the system is usable after phase 2.

## Decisions to confirm

- Definition files in JSON, not YAML, to avoid a parser dependency. A `$schema`
  key gives editor completion.
- Expressions are sandboxed JS predicates in `node:vm`, not a custom language.
- No external engine (Temporal, Inngest, n8n). The interpreter is a few hundred
  lines and fits the "small enough to understand" rule.
- `@xyflow/react` + `@dagrejs/dagre` are the only new web dependencies.
- Feed-triage reply-by-number is modelled as a long-lived `human` wait on the
  same run rather than a separate email-triggered workflow. A night's run stays
  `waiting` until the reply or a 7-day expiry, which is also what the run list
  should show.
