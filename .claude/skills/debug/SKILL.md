---
name: debug
description: Debug agent issues. Use when things aren't working, agent fails, authentication problems, or to understand how the in-process agent system works. Covers logs, environment variables, sessions, and common issues.
---

# NanoClaw Agent Debugging

This guide covers debugging the in-process agent execution system. Agents run directly via the Claude Agent SDK `query()` function within the NanoClaw Node.js process -- there are no containers, VMs, or Docker involved.

## Architecture Overview

```
Host (macOS) - Single Node.js Process
───────────────────────────────────────────────────
src/index.ts                    src/agent-runner.ts
    │                                │
    │ routes WhatsApp messages       │ calls query() from
    │ to agent-runner                │ @anthropic-ai/claude-agent-sdk
    │                                │
    │                                ├── cwd: groups/{folder}/
    │                                ├── resume: sessionId (per-group)
    │                                ├── permissionMode: 'bypassPermissions'
    │                                ├── settingSources: ['project']
    │                                ├── mcpServers: { nanoclaw: ipcMcp }
    │                                └── allowedTools: [Bash, Read, Write, ...]
    │
    ├── groups/{folder}/          Agent working directory (cwd)
    ├── data/ipc/{folder}/        IPC files (messages, tasks)
    ├── data/sessions/{folder}/   Session data (per-group isolation)
    └── .env                      Auth tokens (process.env)
```

**Key point:** The agent runs in the same Node.js process as the host. Environment variables from `.env` are available directly via `process.env`. No volume mounts, no container runtimes, no user mapping.

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app logs** | `logs/nanoclaw.log` | WhatsApp connection, routing, agent spawning |
| **Main app errors** | `logs/nanoclaw.error.log` | Application errors |
| **Agent run logs** | `groups/{folder}/logs/agent-*.log` | Per-run: group, duration, status, errors |
| **Claude sessions** | `data/sessions/{group}/.claude/projects/` | Claude Agent SDK session history |

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

**Check the agent log file** in `groups/{folder}/logs/agent-*.log`

Common causes:

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
Cannot find module '@anthropic-ai/claude-agent-sdk'
```
**Fix:** Reinstall dependencies:
```bash
npm install
```

### 2. Agent Timeout

The agent has a configurable timeout (default 300 seconds / 5 minutes). If a query takes too long, it will be aborted.

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
# Should show the SAME session ID for consecutive messages in the same group
```

**Root cause possibilities:**
- Session data directory missing or corrupted at `data/sessions/{group}/.claude/`
- The `resume` parameter in `query()` not receiving the stored session ID

**Fix:** Clear sessions and let them be recreated:
```bash
# Clear sessions for a specific group
rm -rf data/sessions/{groupFolder}/.claude/

# Clear the session ID from NanoClaw's tracking
echo '{}' > data/sessions.json
```

### 4. MCP Server Failures

The agent uses a file-based IPC MCP server (`nanoclaw`) for sending messages and managing tasks. If the MCP server fails to initialize, the agent may error.

**Check:** Ensure the IPC directory is writable:
```bash
ls -la data/ipc/{groupFolder}/
# Should have messages/ and tasks/ subdirectories
```

### 5. Permission Errors on Group Directories

The agent runs with `cwd` set to `groups/{folder}/`. If this directory is not writable, tools like Bash, Write, and Edit will fail.

**Fix:**
```bash
# Check permissions
ls -la groups/

# Fix ownership if needed
chmod -R u+rw groups/{folder}/
```

### 6. Claude CLI Not Found

The `query()` function from the Claude Agent SDK requires the `claude` CLI to be available on the system PATH.

**Check:**
```bash
which claude
claude --version
```

**Fix:** Install or update Claude Code:
```bash
npm install -g @anthropic-ai/claude-code
```

## Manual Testing

### Test with development server:
```bash
# Run with hot reload - send a WhatsApp message to trigger the agent
npm run dev
```

### Test agent SDK directly:
```bash
# Quick test using Node.js
node -e "
const { query } = require('@anthropic-ai/claude-agent-sdk');
(async () => {
  for await (const msg of query({
    prompt: 'Say hello',
    options: {
      cwd: '$(pwd)/groups/test',
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

The agent-runner uses these Claude Agent SDK options:

```typescript
query({
  prompt: input.prompt,
  options: {
    abortController,
    cwd: groupDir,                          // groups/{folder}/
    resume: input.sessionId,                // Per-group session resumption
    allowedTools: [
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'mcp__nanoclaw__*'
    ],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,  // Required with bypassPermissions
    settingSources: ['project'],
    mcpServers: {
      nanoclaw: ipcMcp                      // File-based IPC MCP server
    },
    hooks: {
      PreCompact: [...]                     // Archives conversations before compaction
    }
  }
})
```

**Important:** `allowDangerouslySkipPermissions: true` is required when using `permissionMode: 'bypassPermissions'`. Without it, the agent will error.

## Rebuilding After Changes

```bash
# Rebuild main app
npm run build

# Run in development mode with hot reload
npm run dev
```

## Session Persistence

Claude sessions are stored per-group in `data/sessions/{group}/.claude/` for security isolation. Each group has its own session directory, preventing cross-group access to conversation history.

To clear sessions:

```bash
# Clear all sessions for all groups
rm -rf data/sessions/

# Clear sessions for a specific group
rm -rf data/sessions/{groupFolder}/.claude/

# Also clear the session ID from NanoClaw's tracking
echo '{}' > data/sessions.json
```

To verify session resumption is working, check the logs for the same session ID across messages:
```bash
grep "Session initialized" logs/nanoclaw.log | tail -5
# Should show the SAME session ID for consecutive messages in the same group
```

## IPC Debugging

The agent communicates back to the host via files in `data/ipc/{folder}/`:

```bash
# Check pending messages
ls -la data/ipc/{folder}/messages/

# Check pending task operations
ls -la data/ipc/{folder}/tasks/

# Read a specific IPC file
cat data/ipc/{folder}/messages/*.json

# Check available groups (main channel only)
cat data/ipc/main/available_groups.json

# Check current tasks snapshot
cat data/ipc/{folder}/current_tasks.json
```

**IPC file types:**
- `messages/*.json` - Agent writes: outgoing WhatsApp messages
- `tasks/*.json` - Agent writes: task operations (schedule, pause, resume, cancel, refresh_groups)
- `current_tasks.json` - Host writes: read-only snapshot of scheduled tasks
- `available_groups.json` - Host writes: read-only list of WhatsApp groups (main only)

## Quick Diagnostic Script

Run this to check common issues:

```bash
echo "=== Checking NanoClaw Setup ==="

echo -e "\n1. Authentication configured?"
[ -f .env ] && (grep -q "CLAUDE_CODE_OAUTH_TOKEN=sk-" .env || grep -q "ANTHROPIC_API_KEY=sk-" .env) && echo "OK" || echo "MISSING - add CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY to .env"

echo -e "\n2. Claude CLI available?"
which claude &>/dev/null && echo "OK - $(claude --version 2>&1 | head -1)" || echo "MISSING - install with: npm install -g @anthropic-ai/claude-code"

echo -e "\n3. Claude Agent SDK installed?"
node -e "require('@anthropic-ai/claude-agent-sdk')" 2>/dev/null && echo "OK" || echo "MISSING - run: npm install"

echo -e "\n4. Node.js version?"
node --version

echo -e "\n5. Groups directory?"
ls -la groups/ 2>/dev/null || echo "MISSING - run setup"

echo -e "\n6. IPC directories?"
ls -d data/ipc/*/ 2>/dev/null && echo "OK" || echo "No IPC directories yet (created on first run)"

echo -e "\n7. Recent agent logs?"
ls -t groups/*/logs/agent-*.log 2>/dev/null | head -3 || echo "No agent logs yet"

echo -e "\n8. Session continuity working?"
SESSIONS=$(grep "Session initialized" logs/nanoclaw.log 2>/dev/null | tail -5 | awk '{print $NF}' | sort -u | wc -l)
[ "$SESSIONS" -le 2 ] && echo "OK (recent sessions reusing IDs)" || echo "CHECK - multiple different session IDs, may indicate resumption issues"

echo -e "\n9. Build up to date?"
[ -d dist ] && echo "OK - dist/ exists (last built: $(stat -f '%Sm' dist 2>/dev/null || stat -c '%y' dist 2>/dev/null))" || echo "NOT BUILT - run: npm run build"
```
