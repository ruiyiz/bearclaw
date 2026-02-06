# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Agent execution | Host process | Runs directly on host, has filesystem access |
| WhatsApp messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Session Isolation

Each group runs with its own working directory (`groups/{folder}/`) and conversation session:
- **Working directory isolation** - Agent's `cwd` is set to the group's folder
- **Session isolation** - Each group has its own session ID in `data/sessions.json`
- **Memory isolation** - Each group has its own `CLAUDE.md`

**Important:** This is application-level isolation, not OS-level. Agents running on the host have full filesystem access. A determined prompt injection could access files outside the group folder.

### 2. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | Yes | Yes |
| Send message to other chats | Yes | No |
| Schedule task for self | Yes | Yes |
| Schedule task for others | Yes | No |
| View all tasks | Yes | Own only |
| Manage other groups | Yes | No |

### 3. Credential Handling

**Environment Variables:**
On bare metal, `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` are available directly via `process.env` from the `.env` file. The agent process inherits the host environment.

> **Note:** Since agents run in-process, they can discover credentials via Bash or file operations. This is a trade-off of the bare metal approach.

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | Full (cwd is group folder, but host fs accessible) | Full (host fs accessible) |
| Group folder | `groups/{folder}/` (cwd) | `groups/{folder}/` (cwd) |
| Global memory | Read/write via parent CLAUDE.md | Read via parent CLAUDE.md |
| Network access | Unrestricted | Unrestricted |
| MCP tools | All | All |

## Security Architecture Diagram

```
+------------------------------------------------------------------+
|                        UNTRUSTED ZONE                             |
|  WhatsApp Messages (potentially malicious)                        |
+--------------------------------+---------------------------------+
                                 |
                                 v  Trigger check, input escaping
+------------------------------------------------------------------+
|                     HOST PROCESS (TRUSTED)                        |
|  * Message routing                                                |
|  * IPC authorization                                              |
|  * Credential handling via .env                                   |
|                                                                   |
|  +------------------------------------------------------------+  |
|  |                  AGENT (IN-PROCESS)                          |  |
|  |  * Claude Agent SDK query()                                  |  |
|  |  * cwd: groups/{folder}/                                     |  |
|  |  * Bash commands (runs on host!)                             |  |
|  |  * File operations (host filesystem access)                  |  |
|  |  * Network access (unrestricted)                             |  |
|  +------------------------------------------------------------+  |
+------------------------------------------------------------------+
```

## Recommendations

- Only register trusted groups
- Review scheduled tasks periodically
- Monitor logs for unusual activity
- For stronger isolation, consider running NanoClaw itself inside a container or VM
