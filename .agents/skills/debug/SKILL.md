---
name: debug
description: Debug agent issues. Use when things aren't working, agent fails, authentication problems, or to understand how the in-process agent system works. Covers logs, environment variables, sessions, and common issues.
---

# NanoClaw Agent Debugging

This guide covers debugging the in-process agent execution system. Agents run directly via the Codex Agent SDK `query()` function within the NanoClaw Node.js process — there are no containers, VMs, or Docker involved.

## Architecture Overview

```
Host (macOS) — Single Node.js Process
───────────────────────────────────────────────────
src/index.ts                     src/agent/runner.ts
    │                                │
    │ routes inbound messages         │ calls query() from
    │ (WhatsApp/Telegram/iMessage)    │ @anthropic-ai/Codex-agent-sdk
    │ to agent runner                 │
    │                                ├── cwd: ~/.nanoclaw/agents/{folder}/
    │                                ├── resume: sessionId (per-agent)
    │                                ├── permissionMode: 'bypassPermissions'
    │                                ├── settingSources: ['project']
    │                                ├── mcpServers: { nanoclaw: ipcMcp }
    │                                └── allowedTools: [Bash, Read, Write, ...]
    │
    ├── ~/.nanoclaw/agents/{folder}/         Agent working directory (cwd)
    ├── ~/.nanoclaw/data/ipc/{folder}/       IPC files (messages, tasks)
    ├── ~/.nanoclaw/context/                 Shared context (AGENTS, SOUL, USER, MEMORY)
    ├── ~/.Codex/projects/{encodedCwd}/     Codex Agent SDK transcript files
    └── .env                                 Auth tokens (process.env)
```

**Key point:** The agent runs in the same Node.js process as the host. Environment variables from `.env` are available directly via `process.env`. No volume mounts, no container runtimes, no user mapping.

## Log Locations

| Log                   | Location                                           | Content                                      |
| --------------------- | -------------------------------------------------- | -------------------------------------------- |
| **Main app logs**     | `logs/nanoclaw.log`                                | Channel connections, routing, agent spawning |
| **Main app errors**   | `logs/nanoclaw.error.log`                          | Application errors                           |
| **Agent run logs**    | `~/.nanoclaw/agents/{folder}/logs/agent-*.log`     | Per-run: agent, duration, status, errors     |
| **Agent transcripts** | `~/.Codex/projects/{encodedCwd}/{sessionId}.jsonl` | Codex Agent SDK conversation history         |
| **Daily memory**      | `~/.nanoclaw/agents/{folder}/memory/YYYY-MM-DD.md` | Agent's running daily log                    |

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
# For development
LOG_LEVEL=debug npm run dev

# For launchd service, add to plist EnvironmentVariables:
<key>LOG_LEVEL</key>
<string>debug</string>
```

Debug level shows:

- Agent start/complete lifecycle events
- Session initialization and IDs
- Input prompt lengths and session resumption details

## Common Issues

### 1. Agent Errors or Unexpected Exits

**Check the agent log file** in `~/.nanoclaw/agents/{folder}/logs/agent-*.log`

#### Missing Authentication

```
Invalid API key
```

**Fix:** Ensure `.env` file exists in the project root with either OAuth token or API key:

```bash
cat .env  # Should show one of:
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  (subscription)
# ANTHROPIC_API_KEY=sk-ant-api03-...        (pay-per-use)
```

#### SDK Import or Version Mismatch

```
Cannot find module '@anthropic-ai/Codex-agent-sdk'
```

**Fix:** Reinstall dependencies:

```bash
bun install
```

### 2. Agent Timeout

Default 300 seconds (5 min); configurable per-agent via `containerConfig.timeout`, or globally via `AGENT_TIMEOUT`.

**Check logs for:**

```
Agent timeout after 300000ms, aborting
```

**Fix:** Increase timeout via environment variable:

```bash
AGENT_TIMEOUT=600000 npm run dev  # 10 minutes
```

Or set it in `.env`:

```
AGENT_TIMEOUT=600000
```

### 3. Session Not Resuming

If sessions are not being resumed (new session ID every time):

**Check the logs for session IDs:**

```bash
grep "Session initialized" logs/nanoclaw.log | tail -5
# Should show the SAME session ID for consecutive messages in the same agent
```

**Root cause possibilities:**

- Daily session reset hour (`SESSION_RESET_HOUR`, default 4am) just fired
- Idle reset (`SESSION_IDLE_MINUTES`) elapsed since last activity
- The transcript at `~/.Codex/projects/{encodedCwd}/{sessionId}.jsonl` was deleted

**Fix:** Clear NanoClaw's session tracking and let the agent recreate one:

```bash
echo '{}' > ~/.nanoclaw/data/sessions.json
```

### 4. MCP Server Failures

The agent uses a file-based IPC MCP server (`nanoclaw`) for sending messages and managing handlers. If the MCP server fails to initialize, the agent may error.

**Check:** Ensure the IPC directory is writable:

```bash
ls -la ~/.nanoclaw/data/ipc/{folder}/
# Should have messages/ and tasks/ subdirectories
```

### 5. Permission Errors on Agent Directories

The agent runs with `cwd` set to `~/.nanoclaw/agents/{folder}/`. If this directory is not writable, tools like Bash, Write, and Edit will fail.

**Fix:**

```bash
ls -la ~/.nanoclaw/agents/
chmod -R u+rw ~/.nanoclaw/agents/{folder}/
```

### 6. Codex CLI Not Found

The `query()` function from the Codex Agent SDK requires the `Codex` CLI to be available on the system PATH.

**Check:**

```bash
which Codex
Codex --version
```

**Fix:** Install or update Codex:

```bash
npm install -g @anthropic-ai/Codex
```

## Manual Testing

### Test with development server:

```bash
# Run with hot reload — send a message on any registered channel to trigger the agent
npm run dev
```

### Test agent SDK directly:

```bash
node -e "
const { query } = require('@anthropic-ai/Codex-agent-sdk');
(async () => {
  for await (const msg of query({
    prompt: 'Say hello',
    options: {
      cwd: '$HOME/.nanoclaw/agents/main',
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project']
    }
  })) {
    if (msg.result) console.log('Result:', msg.result);
  }
})();
"
```

## SDK Options Reference

`src/agent/runner.ts` invokes the SDK with roughly these options:

```typescript
query({
  prompt,
  options: {
    abortController,
    cwd: agentDir,                          // ~/.nanoclaw/agents/{folder}/
    resume: input.sessionId,                // Per-agent session resumption
    model: 'Codex-opus-4-7',
    systemPrompt: { type: 'preset', preset: 'Codex', append: ... },
    allowedTools: [
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'Skill',
      'mcp__*'
    ],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
    mcpServers: { nanoclaw: ipcMcp, ...userMcpServers },
    hooks: { SessionStart: [...] }          // Injects recent daily memory
  }
})
```

**Important:** `allowDangerouslySkipPermissions: true` is required when using `permissionMode: 'bypassPermissions'`.

## Rebuilding After Changes

```bash
npm run build  # tsc compile
npm run dev    # tsx with hot reload
```

## IPC Debugging

The agent communicates back to the host via files in `~/.nanoclaw/data/ipc/{folder}/`:

```bash
# Pending outbound messages
ls -la ~/.nanoclaw/data/ipc/{folder}/messages/

# Pending task/handler operations
ls -la ~/.nanoclaw/data/ipc/{folder}/tasks/

# Read a specific IPC file
cat ~/.nanoclaw/data/ipc/{folder}/messages/*.json

# Available channel chats (main agent only)
cat ~/.nanoclaw/data/ipc/main/available_groups.json

# Current handlers snapshot
cat ~/.nanoclaw/data/ipc/{folder}/current_handlers.json
```

**IPC file types:**

- `messages/*.json` — Agent writes: outgoing channel messages (text or media)
- `tasks/*.json` — Agent writes: handler operations (`schedule_task`, `register_handler`, `pause_handler`, `cancel_handler`, `emit_event`, `register_agent`, `refresh_agents`, `reply_email`)
- `current_handlers.json` — Host writes: read-only snapshot of registered handlers
- `available_groups.json` — Host writes: read-only list of channel chats (main agent only)
- `email_results/{requestId}.json` — Host writes: result of an email reply request

## Quick Diagnostic Script

```bash
echo "=== Checking NanoClaw Setup ==="

echo -e "\n1. Authentication configured?"
[ -f .env ] && (grep -q "CLAUDE_CODE_OAUTH_TOKEN=sk-" .env || grep -q "ANTHROPIC_API_KEY=sk-" .env) && echo "OK" || echo "MISSING - add CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY to .env"

echo -e "\n2. Codex CLI available?"
which Codex &>/dev/null && echo "OK - $(Codex --version 2>&1 | head -1)" || echo "MISSING - install with: npm install -g @anthropic-ai/Codex"

echo -e "\n3. Codex Agent SDK installed?"
node -e "require('@anthropic-ai/Codex-agent-sdk')" 2>/dev/null && echo "OK" || echo "MISSING - run: bun install"

echo -e "\n4. Node.js version?"
node --version

echo -e "\n5. Agents directory?"
ls -la ~/.nanoclaw/agents/ 2>/dev/null || echo "MISSING - run setup"

echo -e "\n6. IPC directories?"
ls -d ~/.nanoclaw/data/ipc/*/ 2>/dev/null && echo "OK" || echo "No IPC directories yet (created on first run)"

echo -e "\n7. Recent agent logs?"
ls -t ~/.nanoclaw/agents/*/logs/agent-*.log 2>/dev/null | head -3 || echo "No agent logs yet"

echo -e "\n8. Session continuity working?"
SESSIONS=$(grep "Session initialized" logs/nanoclaw.log 2>/dev/null | tail -5 | awk '{print $NF}' | sort -u | wc -l)
[ "$SESSIONS" -le 2 ] && echo "OK (recent sessions reusing IDs)" || echo "CHECK - multiple different session IDs, may indicate resumption issues"

echo -e "\n9. Build up to date?"
[ -d dist ] && echo "OK - dist/ exists (last built: $(stat -f '%Sm' dist 2>/dev/null || stat -c '%y' dist 2>/dev/null))" || echo "NOT BUILT - run: npm run build"
```
