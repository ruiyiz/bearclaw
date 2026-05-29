# Agent Identity & Memory Redesign

## Problem

BearClaw's current memory system has three issues:

1. **Mixed concerns**: CLAUDE.md files combine agent identity, user knowledge, operating instructions, and curated memory in a single file.
2. **Tiered inheritance**: A global `~/.bearclaw/groups/CLAUDE.md` is inherited by all groups, with per-group CLAUDE.md files overriding it. This creates implicit dependencies and makes it unclear what each agent actually sees.
3. **SDK coupling**: The system relies on Claude Agent SDK's automatic CLAUDE.md loading behavior, which is opaque and not under our control.

## Design

### File Separation

Split the monolithic CLAUDE.md into purpose-specific files, inspired by OpenClaw's separation but adapted for BearClaw's multi-agent model.

| File          | Scope     | Purpose                                                                                                               |
| ------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`   | Shared    | Operating manual: tool usage, formatting rules, response behavior, agent teams, group chat etiquette, Apple Reminders |
| `SOUL.md`     | Shared    | Core principles: be helpful, have opinions, boundaries, safety                                                        |
| `USER.md`     | Shared    | Facts about the human: work, family, setup, preferences                                                               |
| `MEMORY.md`   | Shared    | Curated long-term knowledge                                                                                           |
| `IDENTITY.md` | Per-agent | Agent-specific identity: name, role, capabilities, elevated privileges (main), channel-specific behavior              |

### Directory Structure

```
~/.bearclaw/
├── context/                    # Shared context injected into every agent
│   ├── AGENTS.md               # Operating manual
│   ├── SOUL.md                 # Core principles
│   ├── USER.md                 # Facts about the human
│   └── MEMORY.md               # Curated long-term knowledge
├── agents/                     # Per-agent directories (renamed from groups/)
│   ├── main/
│   │   ├── IDENTITY.md         # Lead agent identity, elevated privileges
│   │   ├── memory/             # Daily logs (YYYY-MM-DD.md)
│   │   ├── conversations/      # Archived transcripts
│   │   └── workspace/          # Working files for Claude Agent SDK
│   ├── coco/
│   │   ├── IDENTITY.md         # CoCo family group identity
│   │   ├── memory/
│   │   ├── conversations/
│   │   └── workspace/
│   └── .claude/
│       └── skills/             # Agent skills (unchanged)
├── data/
│   ├── registered_agents.json  # Renamed from registered_groups.json
│   ├── sessions.json
│   ├── router_state.json
│   └── ipc/                    # Per-agent IPC (unchanged structure)
├── store/
│   └── messages.db
└── mcp.json
```

### System Prompt Construction

Replace SDK auto-loading with explicit prompt injection in `agent-runner.ts`.

```typescript
function buildContextPrompt(agentFolder: string): string {
  const contextDir = path.join(BEARCLAW_HOME, 'context');
  const agentDir = path.join(BEARCLAW_HOME, 'agents', agentFolder);

  const parts: string[] = [];

  // Shared context files (order matters)
  for (const file of ['AGENTS.md', 'SOUL.md', 'USER.md', 'MEMORY.md']) {
    const filePath = path.join(contextDir, file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (content) parts.push(content);
    }
  }

  // Per-agent identity
  const identityPath = path.join(agentDir, 'IDENTITY.md');
  if (fs.existsSync(identityPath)) {
    const content = fs.readFileSync(identityPath, 'utf-8').trim();
    if (content) parts.push(content);
  }

  return parts.join('\n\n---\n\n');
}
```

The combined context is appended to the system prompt alongside the existing operational instructions (workspace rules, response behavior, memory tool usage).

The `cwd` for the agent SDK remains the per-agent directory (`agents/{folder}/`) so that file operations are scoped correctly.

### Memory System

**Shared curated memory (`context/MEMORY.md`)**:

- Loaded into every agent's system prompt via `buildContextPrompt`.
- Contains distilled, high-signal knowledge that all agents benefit from.
- Agents can update it via the `memory_write` tool (with a `shared: true` flag) or by directly editing the file.

**Per-agent daily logs (`agents/{folder}/memory/YYYY-MM-DD.md`)**:

- Loaded via the `SessionStart` hook (today + yesterday).
- Contain raw conversation context and decisions.
- Written via `memory_write` (default behavior, scoped to current agent).

**Memory search (`memory_search`)**:

- Searches both the agent's own `memory/` + `conversations/` directories AND the shared `context/MEMORY.md`.
- FTS index updated to include shared memory entries alongside per-agent entries.

### Code Changes

#### Renamed concepts

| Before                         | After                          |
| ------------------------------ | ------------------------------ |
| `groups/` directory            | `agents/` directory            |
| `GROUPS_DIR`                   | `AGENTS_DIR`                   |
| `RegisteredGroup`              | `RegisteredAgent`              |
| `group.folder` / `groupFolder` | `agent.folder` / `agentFolder` |
| `registered_groups.json`       | `registered_agents.json`       |
| `MAIN_GROUP_FOLDER`            | `MAIN_AGENT_FOLDER`            |
| `CLAUDE.md` (all)              | Split into separate files      |

#### Files to modify

1. **`src/config.ts`**: Rename constants, update paths.
2. **`src/types.ts`**: Rename `RegisteredGroup` to `RegisteredAgent`.
3. **`src/agent-runner.ts`**: Add `buildContextPrompt()`, update hooks to read from `agents/` and `context/`.
4. **`src/system-prompt.ts`**: Update memory section to reference new file structure. Remove references to CLAUDE.md.
5. **`src/index.ts`**: Update all `group` references to `agent`. Update `registered_groups.json` loading to `registered_agents.json`.
6. **`src/ipc-mcp.ts`**: Update `groupFolder` to `agentFolder`, update `memory_write` to support shared memory, update `memory_search` to include shared context.
7. **`src/db.ts`**: Update `group_folder` references. For the SQLite schema, either rename the column or add a migration. Keeping `group_folder` as the column name for backwards compatibility is acceptable if preferred.
8. **`src/event-bus.ts`**: Update handler references from group to agent.
9. **`src/odyssey.ts`**: Update references.
10. **`src/email-channel.ts`**: Update references.
11. **`src/channels/telegram.ts`**: Update `groupFolder` parameter name.

#### Migration

A one-time migration script or startup check that:

1. Moves `~/.bearclaw/groups/` to `~/.bearclaw/agents/` (if `agents/` doesn't exist).
2. Splits `~/.bearclaw/groups/CLAUDE.md` into `context/AGENTS.md`, `context/SOUL.md`, `context/USER.md`, `context/MEMORY.md`.
3. Renames per-agent `CLAUDE.md` files to `IDENTITY.md`.
4. Renames `registered_groups.json` to `registered_agents.json`.
5. Updates the SQLite `handlers` table if column rename is desired.

### What Stays the Same

- Agent SDK `query()` call structure (still uses `claude_code` preset with appended prompt).
- IPC mechanism (`data/ipc/{folder}/`).
- Session management (`sessions.json` keyed by folder name).
- Bot pool / agent teams (sender-based subagents within a session).
- Skills directory location (`agents/.claude/skills/`).
- Event bus and handler system.
- Daily session reset behavior.
