# Agent Identity & Memory Reorganization - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split the monolithic CLAUDE.md into purpose-specific files (AGENTS.md, SOUL.md, USER.md, MEMORY.md, IDENTITY.md), rename "groups" to "agents" throughout the codebase, and inject context explicitly rather than relying on SDK auto-loading.

**Architecture:** Shared context files live in `~/.nanoclaw/context/`. Per-agent identity and daily logs live in `~/.nanoclaw/agents/{folder}/`. The agent runner reads all files and appends them to the system prompt. No tiered inheritance.

**Tech Stack:** TypeScript, Claude Agent SDK, better-sqlite3, grammy (Telegram), React/Ink (TUI)

---

### Task 1: Rename config constants and paths

**Files:**
- Modify: `src/config.ts`

**Step 1: Rename constants**

In `src/config.ts`, rename:
- `GROUPS_DIR` to `AGENTS_DIR`, change path from `'groups'` to `'agents'`
- `MAIN_GROUP_FOLDER` to `MAIN_AGENT_FOLDER`
- Add `CONTEXT_DIR` constant pointing to `~/.nanoclaw/context/`

```typescript
export const CONTEXT_DIR = path.resolve(NANOCLAW_HOME, 'context');
export const AGENTS_DIR = path.resolve(NANOCLAW_HOME, 'agents');
export const MAIN_AGENT_FOLDER = 'main';
```

**Step 2: Build and verify no runtime errors**

Run: `npm run build`

This will fail because all other files still import the old names. That's expected -- we'll fix them in subsequent tasks.

**Step 3: Commit**

```bash
git add src/config.ts
git commit -m "Rename GROUPS_DIR to AGENTS_DIR, add CONTEXT_DIR"
```

---

### Task 2: Rename types

**Files:**
- Modify: `src/types.ts`

**Step 1: Rename RegisteredGroup to RegisteredAgent**

In `src/types.ts`, rename `RegisteredGroup` interface to `RegisteredAgent`. Keep all fields identical. The `group_folder` field in `Handler` stays as-is for now (it's a DB column name, handled separately).

```typescript
export interface RegisteredAgent {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  odyssey?: OdysseyConfig;
  email?: EmailConfig;
}
```

Also update the `Channel` interface method signatures:
- `sendAsAgent` parameter: `groupFolder` -> `agentFolder`
- `sendMediaAsAgent` parameter: `groupFolder` -> `agentFolder`

**Step 2: Commit**

```bash
git add src/types.ts
git commit -m "Rename RegisteredGroup to RegisteredAgent"
```

---

### Task 3: Update agent-runner.ts - context injection

**Files:**
- Modify: `src/agent-runner.ts`

**Step 1: Update imports**

Replace `GROUPS_DIR` with `AGENTS_DIR`, add `CONTEXT_DIR`. Replace `RegisteredGroup` with `RegisteredAgent`.

**Step 2: Add buildContextPrompt function**

Add this function before `runContainerAgent`:

```typescript
function buildContextPrompt(agentFolder: string): string {
  const contextDir = CONTEXT_DIR;
  const agentDir = path.join(AGENTS_DIR, agentFolder);
  const parts: string[] = [];

  for (const file of ['AGENTS.md', 'SOUL.md', 'USER.md', 'MEMORY.md']) {
    const filePath = path.join(contextDir, file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (content) parts.push(content);
    }
  }

  const identityPath = path.join(agentDir, 'IDENTITY.md');
  if (fs.existsSync(identityPath)) {
    const content = fs.readFileSync(identityPath, 'utf-8').trim();
    if (content) parts.push(content);
  }

  return parts.join('\n\n---\n\n');
}
```

**Step 3: Update runContainerAgent to use buildContextPrompt**

In `runContainerAgent`:
- Change `groupDir` to `agentDir`, use `AGENTS_DIR` instead of `GROUPS_DIR`
- Build the full system prompt by combining `buildContextPrompt(input.groupFolder)` with `SYSTEM_PROMPT`
- Update the `systemPrompt` option:

```typescript
const contextPrompt = buildContextPrompt(input.groupFolder);
const fullSystemPrompt = [contextPrompt, SYSTEM_PROMPT].filter(Boolean).join('\n\n---\n\n');

// In query() options:
systemPrompt: {
  type: 'preset',
  preset: 'claude_code',
  append: fullSystemPrompt,
},
```

**Step 4: Update all `groupDir` references to `agentDir`**

Throughout the file, rename local variables from `groupDir` to `agentDir`. Update hooks to use `AGENTS_DIR`.

**Step 5: Update ContainerInput interface**

Rename `groupFolder` to `agentFolder` in the `ContainerInput` interface. Update `runContainerAgent` signature to take `RegisteredAgent` instead of `RegisteredGroup`.

**Step 6: Rename writeGroupsSnapshot to writeAgentsSnapshot and writeHandlersSnapshot parameter names**

**Step 7: Commit**

```bash
git add src/agent-runner.ts
git commit -m "Inject context files explicitly, rename group to agent"
```

---

### Task 4: Update system-prompt.ts

**Files:**
- Modify: `src/system-prompt.ts`

**Step 1: Update WORKSPACE section**

Change "Your working directory is your group folder" to "Your working directory is your agent folder."

**Step 2: Update MEMORY section**

Replace the CLAUDE.md reference:

```typescript
const MEMORY = `
## Memory System

You have two layers of memory:

Shared memory — context/MEMORY.md contains curated, durable facts shared across all agents.
It's loaded into every conversation. You can also read context/USER.md and context/SOUL.md in your working directory's parent.

Daily logs — running context stored in memory/YYYY-MM-DD.md files in your agent directory.
Use mcp__nanoclaw__memory_write to save notes, observations, decisions, task progress.
Always use this tool for daily logs. Do not use Write/Edit to create memory files manually.
The tool handles paths, timestamps, and search indexing automatically.

Use mcp__nanoclaw__memory_search to keyword-search across memory/ and conversations/ files.
Prefer this over manually reading files when looking for past context.

During long conversations, proactively use memory_write to save important decisions and context.
Do not wait until the end. Your context may be compacted without warning.
`;
```

**Step 3: Commit**

```bash
git add src/system-prompt.ts
git commit -m "Update system prompt to reference new memory structure"
```

---

### Task 5: Update ipc-mcp.ts

**Files:**
- Modify: `src/ipc-mcp.ts`

**Step 1: Update imports and interface**

- Replace `GROUPS_DIR` with `AGENTS_DIR`
- Rename `groupFolder` to `agentFolder` in `IpcMcpContext` and destructuring
- Rename `target_group` parameter to `target_agent` in schedule_task, register_handler, register_group tools
- Update tool descriptions to say "agent" instead of "group"

**Step 2: Update memory_search to include shared context**

Update the `memory_search` tool to also index and search `context/MEMORY.md`:

```typescript
async (args) => {
  const agentDir = path.join(AGENTS_DIR, agentFolder);
  indexMemoryFiles(agentFolder, agentDir);
  const results = searchMemory(agentFolder, args.query, args.limit);
  // ... rest unchanged
}
```

**Step 3: Update memory_write tool**

Add a `shared` boolean parameter. When true, write to `context/MEMORY.md` instead of daily logs.

```typescript
tool(
  'memory_write',
  `Save a note to memory. By default saves to your daily log (memory/YYYY-MM-DD.md).
Set shared=true to append to the shared context/MEMORY.md instead.`,
  {
    content: z.string().describe('The note to save'),
    topic: z.string().optional().describe('Optional topic header'),
    shared: z.boolean().default(false).describe('Write to shared MEMORY.md instead of daily log'),
  },
  async (args) => {
    if (args.shared) {
      const memoryFile = path.join(CONTEXT_DIR, 'MEMORY.md');
      fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
      const entry = args.topic
        ? `\n## ${args.topic}\n\n${args.content}\n`
        : `\n${args.content}\n`;
      fs.appendFileSync(memoryFile, entry);
      return { content: [{ type: 'text', text: 'Saved to context/MEMORY.md' }] };
    }
    // ... existing daily log logic, using AGENTS_DIR
  }
)
```

**Step 4: Rename register_group tool to register_agent**

Update tool name, description, error messages, and IPC data type.

**Step 5: Update context_mode enum value**

The `context_mode: 'group'` enum value means "shared session" (vs "isolated"). Rename it to `'agent'` in tool schemas and descriptions. This will also need updating in event-bus.ts, db.ts, and types.ts.

**Step 6: Commit**

```bash
git add src/ipc-mcp.ts
git commit -m "Update IPC MCP tools for agent terminology and shared memory"
```

---

### Task 6: Update db.ts

**Files:**
- Modify: `src/db.ts`

**Step 1: Keep `group_folder` as the SQLite column name**

The database column stays as `group_folder` to avoid a schema migration. The code can use `agentFolder` in TypeScript but map to `group_folder` when writing SQL.

**Step 2: Rename function `getHandlersForGroup` to `getHandlersForAgent`**

Update function name and parameter name, keep SQL column reference as `group_folder`.

**Step 3: Update `indexMemoryFiles` and `searchMemory`**

These functions take `groupFolder` as a parameter -- rename to `agentFolder` but keep `group_folder` in SQL queries.

Also update `indexMemoryFiles` to optionally index the shared `context/MEMORY.md`:

```typescript
export function indexMemoryFiles(agentFolder: string, agentDir: string): void {
  const dirs = [
    { dir: path.join(agentDir, 'memory'), prefix: 'memory' },
    { dir: path.join(agentDir, 'conversations'), prefix: 'conversations' },
  ];
  // ... existing logic, just with renamed parameter
}
```

**Step 4: Commit**

```bash
git add src/db.ts
git commit -m "Rename group parameters to agent in db functions"
```

---

### Task 7: Update event-bus.ts

**Files:**
- Modify: `src/event-bus.ts`

**Step 1: Update imports**

Replace `GROUPS_DIR` with `AGENTS_DIR`, `MAIN_GROUP_FOLDER` with `MAIN_AGENT_FOLDER`, `RegisteredGroup` with `RegisteredAgent`.

**Step 2: Rename variables and update references**

- `groupDir` -> `agentDir`
- `handler.group_folder` stays (DB column)
- Update log messages from "Group not found" to "Agent not found"
- `context_mode === 'group'` -> `context_mode === 'agent'`

**Step 3: Update EventBusDependencies interface**

```typescript
export interface EventBusDependencies {
  registeredAgents: () => Record<string, RegisteredAgent>;
  getSessions: () => Record<string, string>;
  saveSessions: () => void;
}
```

**Step 4: Commit**

```bash
git add src/event-bus.ts
git commit -m "Update event bus for agent terminology"
```

---

### Task 8: Update odyssey.ts and email-channel.ts

**Files:**
- Modify: `src/odyssey.ts`
- Modify: `src/email-channel.ts`

**Step 1: Update odyssey.ts**

- Replace `RegisteredGroup` with `RegisteredAgent`
- Rename function parameter from `groups` to `agents`
- Rename loop variable from `group` to `agent`
- Update log messages

**Step 2: Update email-channel.ts**

- Replace `RegisteredGroup` with `RegisteredAgent`
- Rename function parameters and variables from `group`/`groups` to `agent`/`agents`
- Update log messages

**Step 3: Commit**

```bash
git add src/odyssey.ts src/email-channel.ts
git commit -m "Update odyssey and email channel for agent terminology"
```

---

### Task 9: Update channel files

**Files:**
- Modify: `src/channels/telegram.ts`
- Modify: `src/channels/whatsapp.ts`

**Step 1: Update telegram.ts**

- Replace `GROUPS_DIR` import with `AGENTS_DIR`
- Rename `TelegramChannelOpts.registeredGroups` to `registeredAgents`
- Rename `groupFolder` parameter to `agentFolder` in `sendAsAgent`, `sendMediaAsAgent`, `downloadTelegramFile`, `sendPoolMessage`
- Update `GROUPS_DIR` references in media path to `AGENTS_DIR`

Note: WhatsApp's `groupFetchAllParticipating()` is a WhatsApp API method -- the variable `groups` in that context refers to WhatsApp groups, not NanoClaw groups. Those references stay as-is.

**Step 2: Update whatsapp.ts**

- Replace `GROUPS_DIR` import with `AGENTS_DIR`
- Rename `WhatsAppChannelOpts.registeredGroups` to `registeredAgents`
- Update `GROUPS_DIR` references in media path to `AGENTS_DIR`
- Keep WhatsApp-specific "group" references (e.g., `groupFetchAllParticipating`, `groupSyncTimerStarted`) since those refer to WhatsApp groups

**Step 3: Commit**

```bash
git add src/channels/telegram.ts src/channels/whatsapp.ts
git commit -m "Update channel files for agent terminology"
```

---

### Task 10: Update index.ts (main routing)

**Files:**
- Modify: `src/index.ts`

This is the largest file. Key changes:

**Step 1: Update imports**

- Replace `GROUPS_DIR` with `AGENTS_DIR`, `MAIN_GROUP_FOLDER` with `MAIN_AGENT_FOLDER`
- Replace `RegisteredGroup` with `RegisteredAgent`
- Replace `writeGroupsSnapshot` with `writeAgentsSnapshot`

**Step 2: Rename state variables**

- `registeredGroups` -> `registeredAgents`
- `registerGroup()` function -> `registerAgent()`
- File path: `registered_groups.json` -> `registered_agents.json`

**Step 3: Update IPC processing**

- `sourceGroup` -> `sourceAgent`
- `targetGroup` -> `targetAgent`
- `groupFolders` -> `agentFolders`
- Update `case 'register_group':` to `case 'register_agent':`
- Update `case 'refresh_groups':` to `case 'refresh_agents':`

**Step 4: Update all `groupFolder` references to `agentFolder`**

Throughout the file, in `runAgent()`, IPC watcher, and session management.

**Step 5: Update log messages**

Replace "Group" with "Agent" in log messages.

**Step 6: Commit**

```bash
git add src/index.ts
git commit -m "Update main index.ts for agent terminology"
```

---

### Task 11: Update TUI

**Files:**
- Modify: `src/tui/data.ts`
- Modify: `src/tui/views/groups.tsx` (rename to `agents.tsx`)
- Modify: `src/tui/app.tsx`

**Step 1: Update data.ts**

- Rename `getRegisteredGroups` to `getRegisteredAgents`
- Update file path from `registered_groups.json` to `registered_agents.json`
- Update `GROUPS_DIR` import to `AGENTS_DIR`

**Step 2: Rename groups.tsx to agents.tsx**

- Rename file
- Rename `GroupsView` to `AgentsView`
- Update `GROUPS_DIR` to `AGENTS_DIR`
- Update `RegisteredGroup` to `RegisteredAgent`
- Change CLAUDE.md reference to IDENTITY.md
- Update display text from "Group Details" to "Agent Details"

**Step 3: Update app.tsx**

- Update import from `groups.js` to `agents.js`
- Update tab key from `'groups'` to `'agents'`
- Update tab label from `'Groups'` to `'Agents'`
- Update component reference from `GroupsView` to `AgentsView`

**Step 4: Commit**

```bash
git add src/tui/
git commit -m "Rename Groups to Agents in TUI"
```

---

### Task 12: Update project CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update key files table**

Update the table to reference new paths:
- `~/.nanoclaw/agents/{name}/IDENTITY.md` instead of `~/.nanoclaw/groups/{name}/CLAUDE.md`
- Add `~/.nanoclaw/context/` files

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "Update CLAUDE.md to reference new agent/context paths"
```

---

### Task 13: Update context_mode enum value

**Files:**
- Modify: `src/types.ts`
- Modify: `src/ipc-mcp.ts`
- Modify: `src/event-bus.ts`
- Modify: `src/db.ts`

**Step 1: Rename 'group' to 'agent' in context_mode**

In `src/types.ts`, change `Handler.context_mode` type from `'group' | 'isolated'` to `'agent' | 'isolated'`.

In `src/ipc-mcp.ts`, update the `z.enum(['group', 'isolated'])` to `z.enum(['agent', 'isolated'])` in `schedule_task` and `register_handler` tools.

In `src/event-bus.ts`, update `handler.context_mode === 'group'` to `handler.context_mode === 'agent'`.

In `src/db.ts`, update the default value in the `CREATE TABLE` statement from `'isolated'` (already correct, just verify). The existing `group` values in the DB will need a migration:

```sql
UPDATE handlers SET context_mode = 'agent' WHERE context_mode = 'group';
```

Add this to `initDatabase()` as a migration step.

**Step 2: Commit**

```bash
git add src/types.ts src/ipc-mcp.ts src/event-bus.ts src/db.ts
git commit -m "Rename context_mode 'group' to 'agent'"
```

---

### Task 14: Write migration logic

**Files:**
- Modify: `src/index.ts` (or create `src/migrate.ts`)

**Step 1: Add startup migration in index.ts**

Add a `migrateToAgents()` function called on startup, before loading registered agents:

```typescript
function migrateToAgents(): void {
  const oldGroupsDir = path.join(NANOCLAW_HOME, 'groups');
  const newAgentsDir = path.join(NANOCLAW_HOME, 'agents');
  const contextDir = path.join(NANOCLAW_HOME, 'context');

  // Skip if already migrated
  if (fs.existsSync(newAgentsDir) || !fs.existsSync(oldGroupsDir)) return;

  logger.info('Migrating groups/ to agents/ and context/...');

  // 1. Move groups/ -> agents/
  fs.renameSync(oldGroupsDir, newAgentsDir);

  // 2. Split global CLAUDE.md into context/ files
  const globalClaudeMd = path.join(newAgentsDir, 'CLAUDE.md');
  if (fs.existsSync(globalClaudeMd)) {
    fs.mkdirSync(contextDir, { recursive: true });
    // Move the global CLAUDE.md to context/AGENTS.md as a starting point
    // User will need to manually split it into AGENTS.md, SOUL.md, USER.md, MEMORY.md
    fs.renameSync(globalClaudeMd, path.join(contextDir, 'AGENTS.md'));
    logger.info('Moved groups/CLAUDE.md to context/AGENTS.md — split into SOUL.md, USER.md, MEMORY.md manually');
  }

  // 3. Rename per-agent CLAUDE.md -> IDENTITY.md
  for (const entry of fs.readdirSync(newAgentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const claudePath = path.join(newAgentsDir, entry.name, 'CLAUDE.md');
    const identityPath = path.join(newAgentsDir, entry.name, 'IDENTITY.md');
    if (fs.existsSync(claudePath) && !fs.existsSync(identityPath)) {
      fs.renameSync(claudePath, identityPath);
    }
  }

  // 4. Rename registered_groups.json -> registered_agents.json
  const oldFile = path.join(DATA_DIR, 'registered_groups.json');
  const newFile = path.join(DATA_DIR, 'registered_agents.json');
  if (fs.existsSync(oldFile) && !fs.existsSync(newFile)) {
    fs.renameSync(oldFile, newFile);
  }

  logger.info('Migration complete');
}
```

**Step 2: Commit**

```bash
git add src/index.ts
git commit -m "Add startup migration from groups to agents"
```

---

### Task 15: Build, verify, and final commit

**Step 1: Build**

Run: `npm run build`

Fix any remaining TypeScript errors.

**Step 2: Verify**

Check that no references to `GROUPS_DIR`, `RegisteredGroup`, `registered_groups.json`, or `CLAUDE.md` (in code, not docs) remain:

```bash
grep -r "GROUPS_DIR\|RegisteredGroup\|registered_groups" src/ --include="*.ts" --include="*.tsx"
```

**Step 3: Commit any remaining fixes**

```bash
git add -A
git commit -m "Fix remaining references from groups to agents"
```

---

### Task 16: Create initial context files

This is a manual/semi-manual task. Split the current `~/.nanoclaw/groups/CLAUDE.md` content into:

1. `~/.nanoclaw/context/AGENTS.md` — Operating manual sections (workspace, responses, formatting, agent teams, group chat behavior, Apple Reminders, iMessage)
2. `~/.nanoclaw/context/SOUL.md` — Core principles section (identity & personality, boundaries)
3. `~/.nanoclaw/context/USER.md` — About Mike section (work, family, interests, setup)
4. `~/.nanoclaw/context/MEMORY.md` — Any curated knowledge not covered above
5. `~/.nanoclaw/agents/main/IDENTITY.md` — Merge current main/CLAUDE.md elevated privileges with agent-specific identity
6. `~/.nanoclaw/agents/coco/IDENTITY.md` — CoCo-specific identity if different from main

**Step 1: Create the files**

This should be done by reading the current CLAUDE.md and splitting content into the appropriate files.

**Step 2: Verify by running the service**

Run: `npm run dev`

Send a test message and verify the agent receives the correct context.
