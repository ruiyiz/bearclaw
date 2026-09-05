# BearClaw Security Model

## Trust Model

| Entity           | Trust Level  | Rationale                                    |
| ---------------- | ------------ | -------------------------------------------- |
| Main agent       | Trusted      | Private self-chat, admin control             |
| Non-main agents  | Untrusted    | Other participants may be malicious          |
| Agent execution  | Host process | Runs directly on host, has filesystem access |
| Inbound messages | User input   | Potential prompt injection                   |

## Security Boundaries

### 1. Session Isolation

Each agent runs with its own working directory (`~/.bearclaw/var/agents/{folder}/`) and conversation session:

- **Working directory isolation** — Agent's `cwd` is set to the agent's own folder under `var/agents/`
- **Session isolation** — Each agent has its own session ID in `~/.bearclaw/var/sessions.json`
- **Identity isolation** — Each agent has its own `IDENTITY.md` row; only the shared context rows are loaded across agents
- **Mirror is read-only** — Skills and context reach the agent as regenerated copies under `var/cache/`, linked into the cwd; a `PreToolUse` hook denies Write/Edit anywhere under that tree

**Important:** This is application-level isolation, not OS-level. Agents running on the host have full filesystem access. A determined prompt injection could access files outside the agent folder.

### 2. IPC Authorization

Outbound messages and handler operations are verified against the source agent's identity (in `src/app.ts`'s IPC watcher):

| Operation                                         | Main Agent | Non-Main Agent |
| ------------------------------------------------- | ---------- | -------------- |
| Send message to own chat                          | Yes        | Yes            |
| Send message to other chats                       | Yes        | No             |
| Schedule task / register handler for self         | Yes        | Yes            |
| Schedule task / register handler for other agents | Yes        | No             |
| Pause / resume / cancel any handler               | Yes        | Own only       |
| `register_agent`, `refresh_agents`                | Yes        | No             |
| `emit_event`, `reply_email`                       | Yes        | Yes            |
| `context_write` on own `IDENTITY.md`              | Yes        | Yes            |
| `context_write` on shared or another folder's row | Yes        | No             |

### 3. Credential Handling

**Where secrets live.** Every credential is a row in the config database at
`~/.bearclaw/bearclaw.db`, created mode 0600. Rows flagged `secret` (any key
matching `TOKEN|KEY|PASSWORD|SECRET`) are redacted by the listing routes and the
CLI, but they are stored in the clear: file permissions and full-disk encryption
are the protection, not encryption at rest. The one hashed value is the web
password, kept as scrypt (N=16384, r=8, p=1, 16-byte salt, constant-time
compare) under `bearclaw.password_hash`.

**Environment precedence.** At boot the settings rows are copied into
`process.env` without overwriting anything already set, so an environment
variable always beats the database. `BEARCLAW_PASSWORD` overrides the stored
hash outright, which is the escape hatch when the password is lost.

**Inheritance.** Agent subprocesses inherit `process.env`, so a credential is
visible to any Bash the agent runs. Unchanged from the `.env` era: moving the
values into a database narrowed who can read them at rest, not what a running
agent can see.

**Export bundles.** `bearclaw export` writes the config database and the channel
credentials into one tarball, mode 0600, secrets in the clear. Treat a bundle
exactly like the database it contains.

> **Note:** Since agents run in-process, they can discover credentials via Bash or file operations. This is a trade-off of the bare-metal approach.

## Privilege Comparison

| Capability          | Main Agent                                     | Non-Main Agent                           |
| ------------------- | ---------------------------------------------- | ---------------------------------------- |
| Project root access | Full (cwd is agent folder, host fs accessible) | Full (host fs accessible)                |
| Agent folder        | `~/.bearclaw/var/agents/{folder}/` (cwd)       | `~/.bearclaw/var/agents/{folder}/` (cwd) |
| Shared context      | Read + write via `context_write`               | Read only                                |
| Network access      | Unrestricted                                   | Unrestricted                             |
| MCP tools           | All                                            | All                                      |

## Security Architecture Diagram

```
+------------------------------------------------------------------+
|                        UNTRUSTED ZONE                            |
|  Inbound channel + integration messages                          |
|  (WhatsApp / Telegram / iMessage / Email — potentially malicious)|
+--------------------------------+---------------------------------+
                                 |
                                 v  Trigger check, input escaping
+------------------------------------------------------------------+
|                     HOST PROCESS (TRUSTED)                       |
|  * Channel adapters & router                                     |
|  * Event bus & scheduler                                         |
|  * IPC watcher with per-agent authorization                      |
|  * Credentials from ~/.bearclaw/bearclaw.db (mode 0600)          |
|                                                                  |
|  +------------------------------------------------------------+  |
|  |                  AGENT (IN-PROCESS)                        |  |
|  |  * Claude Agent SDK query()                                |  |
|  |  * cwd: ~/.bearclaw/var/agents/{folder}/                   |  |
|  |  * Bash commands (runs on host!)                           |  |
|  |  * File operations (host filesystem access)                |  |
|  |  * Network access (unrestricted)                           |  |
|  +------------------------------------------------------------+  |
+------------------------------------------------------------------+
```

## Recommendations

- Only register trusted chats as agents
- Review workflows and their triggers periodically (`workflow_list` / `trigger_list`, or the Workflows module in the web UI)
- Monitor logs for unusual activity (`logs/bearclaw.log`, `~/.bearclaw/var/agents/*/logs/`)
- Keep export bundles off shared storage, and delete them once restored
- `bearclaw doctor` checks that `bearclaw.db` is still mode 0600
- For stronger isolation, consider running BearClaw itself inside a container or VM
