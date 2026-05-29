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

Each agent runs with its own working directory (`~/.bearclaw/agents/{folder}/`) and conversation session:

- **Working directory isolation** — Agent's `cwd` is set to the agent's folder
- **Session isolation** — Each agent has its own session ID in `~/.bearclaw/data/sessions.json`
- **Identity isolation** — Each agent has its own `IDENTITY.md`; only shared `~/.bearclaw/context/*.md` is loaded across agents

**Important:** This is application-level isolation, not OS-level. Agents running on the host have full filesystem access. A determined prompt injection could access files outside the agent folder.

### 2. IPC Authorization

Outbound messages and handler operations are verified against the source agent's identity (in `src/index.ts`'s IPC watcher):

| Operation                                         | Main Agent | Non-Main Agent |
| ------------------------------------------------- | ---------- | -------------- |
| Send message to own chat                          | Yes        | Yes            |
| Send message to other chats                       | Yes        | No             |
| Schedule task / register handler for self         | Yes        | Yes            |
| Schedule task / register handler for other agents | Yes        | No             |
| Pause / resume / cancel any handler               | Yes        | Own only       |
| `register_agent`, `refresh_agents`                | Yes        | No             |
| `emit_event`, `reply_email`                       | Yes        | Yes            |

### 3. Credential Handling

**Environment variables:**
`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` are loaded from `~/.bearclaw/.env` (via `dotenv`) into `process.env`. The agent process inherits the host environment.

> **Note:** Since agents run in-process, they can discover credentials via Bash or file operations. This is a trade-off of the bare-metal approach.

## Privilege Comparison

| Capability          | Main Agent                                     | Non-Main Agent                           |
| ------------------- | ---------------------------------------------- | ---------------------------------------- |
| Project root access | Full (cwd is agent folder, host fs accessible) | Full (host fs accessible)                |
| Agent folder        | `~/.bearclaw/agents/{folder}/` (cwd)           | `~/.bearclaw/agents/{folder}/` (cwd)     |
| Shared context      | Read/write via `~/.bearclaw/context/MEMORY.md` | Read via `~/.bearclaw/context/MEMORY.md` |
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
|  * Credential handling via ~/.bearclaw/.env                      |
|                                                                  |
|  +------------------------------------------------------------+  |
|  |                  AGENT (IN-PROCESS)                        |  |
|  |  * Claude Agent SDK query()                                |  |
|  |  * cwd: ~/.bearclaw/agents/{folder}/                       |  |
|  |  * Bash commands (runs on host!)                           |  |
|  |  * File operations (host filesystem access)                |  |
|  |  * Network access (unrestricted)                           |  |
|  +------------------------------------------------------------+  |
+------------------------------------------------------------------+
```

## Recommendations

- Only register trusted chats as agents
- Review registered handlers periodically (`list_handlers`, or the TUI handlers view)
- Monitor logs for unusual activity (`logs/bearclaw.log`, `~/.bearclaw/agents/*/logs/`)
- For stronger isolation, consider running BearClaw itself inside a container or VM
