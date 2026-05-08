# GBrain Cutover Plan

NanoClaw → adopt GBrain as primary memory system. Single commit on main. QMD + dream pipeline removed.

## Locked decisions

| Item                | Value                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GBrain repo clone   | `~/Developer/Repos/gbrain`                                                                                              |
| Brain path          | `~/Vault/brain` (PGLite)                                                                                                |
| Topology            | 1 brain, 2 sources (`main`, `coco`), federated=true                                                                     |
| Identity files      | Manual at `~/.nanoclaw/context/{AGENTS,SOUL,USER}.md` + `~/.nanoclaw/agents/{name}/IDENTITY.md`. Not touched by gbrain. |
| Eval bench + doctor | Opt in. Separate gbrain-side cron.                                                                                      |
| Runtime             | GBrain runs as launchd-managed persistent HTTP MCP. Other tools (Claude Code, Cursor, NanoClaw) connect to same socket. |
| Branching           | Single commit on main. QMD work uncommitted, folded in.                                                                 |
| QMD                 | Fully removed (npm uninstall + delete files + drop mcp.json entry).                                                     |

## Final architecture

```
launchd
├── com.nanoclaw.plist          chat orchestrator + agent runner
├── com.nanoclaw.gbrain.plist   gbrain mcp serve (HTTP, persistent)
└── com.nanoclaw.imsg-watcher

NanoClaw (gbrain-agnostic)
  src/
    index.ts, config.ts, db.ts, logger.ts, types.ts
    agent/   runner, ipc-mcp, conversation-checkpoint, system-prompt, subprocess-manager, image-gen
    channels/, events/, integrations/, media/, utils/, scripts/, tui/

GBrain (~/Developer/Repos/gbrain, separate clone)
  brain at ~/Vault/brain
  cron: live-sync 15min, dream-cycle 02:00, doctor weekly, eval contributor opt-in
```

NanoClaw → gbrain coupling = `~/.nanoclaw/config/mcp.json` HTTP entry only. No code import.

## Removals (single commit)

Files deleted:

```
src/dream/                                 (whole dir)
src/agent/embedder.ts
src/agent/memory-embed.ts
src/scripts/qmd-setup.ts
src/scripts/trigger-dream-report.ts
src/scripts/migrate-memory.ts              (one-shot, complete)
src/scripts/flush-conversations.ts         (one-shot, complete)
scripts/setup-qmd.sh
```

Code edits:

- `src/db.ts` — drop `dream_runs`, `dream_reports`, `memory_files`, `memory_chunks`, `memory_fts`, `memory_vec` tables + helpers. One-shot `DROP TABLE IF EXISTS` migration on boot.
- `src/events/bus.ts` — drop `DREAM_HANDLER_PREFIX` branch + dream imports.
- `src/agent/runner.ts` — rewrite `createSessionStartHook`: read live checkpoint + last 2 conversation-archive days only.
- `src/agent/system-prompt.ts` — rewrite MEMORY section. Probe `mcp__gbrain__*` at session-start; conditionally include retrieval guidance.
- `src/agent/ipc-mcp.ts` — drop `memory_write`, `memory_search` MCP tools.
- `src/config.ts` — drop `DREAM_*` exports + `WARM_START_BUDGET`. Add `WARM_START_DAYS=2`, `WARM_START_BUDGET_BYTES=16384`.
- `src/index.ts` — drop `registerDreamHandlers` call.
- `CLAUDE.md` — update Source Layout (drop dream/), Key Files table (drop dream rows + memory rows), add gbrain note.

System prompt MEMORY (final):

```
## Memory

This session has:
- Live transcript (this session, in your context).
- Today's checkpoint (if a session crashed earlier today).
- Last 2 days of your conversation archives, injected at warm-start.
- Cross-session shared context: AGENTS.md, SOUL.md, USER.md, IDENTITY.md.

[if mcp__gbrain__* tools present]
- Long-term memory via mcp__gbrain__query (hybrid keyword+vector), mcp__gbrain__get_page, mcp__gbrain__graph_query. Search the brain BEFORE answering questions about people, companies, prior decisions, or recurring topics — it has structured pages with timelines and provenance.
```

## Persistent gbrain MCP

`~/Library/LaunchAgents/com.nanoclaw.gbrain.plist`:

```xml
<key>Label</key><string>com.nanoclaw.gbrain</string>
<key>ProgramArguments</key>
<array>
  <string>/Users/ruiyiz/.bun/bin/gbrain</string>
  <string>mcp</string>
  <string>serve</string>
  <string>--http</string>
  <string>:3457</string>
</array>
<key>EnvironmentVariables</key>
<dict>
  <key>OPENAI_API_KEY</key><string>…</string>
  <key>ANTHROPIC_API_KEY</key><string>…</string>
  <key>GBRAIN_BRAIN_PATH</key><string>/Users/ruiyiz/Vault/brain</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>/Users/ruiyiz/Vault/brain/.logs/gbrain.log</string>
<key>StandardErrorPath</key><string>/Users/ruiyiz/Vault/brain/.logs/gbrain.error.log</string>
```

`~/.nanoclaw/config/mcp.json`:

```json
{
  "mcpServers": {
    "gbrain": {
      "type": "http",
      "url": "http://localhost:3457"
    }
  }
}
```

If gbrain CLI lacks HTTP mode, fall back to stdio per-session (degrades persistent-MCP latency win, everything else still works).

## Migration steps

1. **Verify gbrain HTTP MCP flag** — fetch `docs/mcp/DEPLOY.md` from gbrain repo. If HTTP not supported, switch fallback to stdio per-session.
2. **Clone + install gbrain**:
   ```
   git clone https://github.com/garrytan/gbrain.git ~/Developer/Repos/gbrain
   cd ~/Developer/Repos/gbrain
   bun install && bun link
   gbrain --version
   ```
3. **Init brain** at `~/Vault/brain`:
   ```
   mkdir -p ~/Vault/brain/.logs ~/Vault/brain/.cron
   GBRAIN_BRAIN_PATH=~/Vault/brain gbrain init
   gbrain doctor
   ```
4. **Add sources**:
   ```
   gbrain sources add main --local-path ~/.nanoclaw/var/agents/main/conversations
   gbrain sources add coco --local-path ~/.nanoclaw/var/agents/coco/conversations
   ```
5. **Bulk import + embed**:
   ```
   gbrain import ~/.nanoclaw/var/agents/main/conversations --source main --no-embed
   gbrain import ~/.nanoclaw/var/agents/coco/conversations --source coco --no-embed
   gbrain embed --stale
   gbrain stats
   gbrain query "Roth backdoor" --source main   # smoke test, time it
   ```
6. **Backup nanoclaw memory state**:
   ```
   tar -czf ~/.nanoclaw/var/backups/pre-gbrain-$(date +%F).tar.gz \
     ~/.nanoclaw/var/agents/main/engrams \
     ~/.nanoclaw/var/agents/coco/engrams \
     ~/.nanoclaw/var/agents/main/dreams \
     ~/.nanoclaw/var/agents/coco/dreams \
     ~/.nanoclaw/var/pending
   ```
7. **NanoClaw code changes** (one commit). All deletions + edits per Removals section. `npm run build` clean.
8. **Uninstall QMD**:
   ```
   npm uninstall -g @tobilu/qmd
   rm -rf ~/.qmd                  # confirm with user before this
   ```
9. **Stop nanoclaw**: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
10. **Install gbrain launchd**: write `com.nanoclaw.gbrain.plist`. `launchctl load`. Verify `curl localhost:3457` responds (or whatever gbrain's health endpoint is).
11. **Update mcp.json**: replace qmd entry with gbrain HTTP entry.
12. **Boot nanoclaw**: `launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist`.
13. **Smoke test via Telegram**: send "what do you know about Angela?" → agent calls `mcp__gbrain__query` → answers using brain. Time response. Target < 30s.
14. **Removability test**: temp-remove gbrain entry from mcp.json, restart, ask same question → agent answers from 2-day window only. Re-add entry.
15. **Schedule gbrain crons** (user crontab, gbrain-owned):
    ```
    */15 * * * * /Users/ruiyiz/.bun/bin/gbrain sync --repo ~/Vault/brain && /Users/ruiyiz/.bun/bin/gbrain embed --stale
    0 2 * * *   /Users/ruiyiz/Vault/brain/.cron/dream-cycle.sh
    0 6 * * 1   /Users/ruiyiz/.bun/bin/gbrain doctor --json >> /Users/ruiyiz/Vault/brain/.logs/doctor.log
    ```
    Add `GBRAIN_CONTRIBUTOR_MODE=1` to launchd plist for eval opt-in. Weekly `gbrain eval export --since 7d` if desired.
16. **Commit**:
    Title: `Cutover memory system to GBrain (drop dream/qmd)`
    Body:
    - Remove dream/ pipeline, engram store, QMD MCP, memory\_\* tables
    - Replace warm-start with checkpoint + 2-day conversation window
    - System prompt MEMORY rewritten; gbrain MCP probed at session start
    - GBrain runs as launchd-managed HTTP MCP (separate plist)
    - Manual context preserved
17. **Push to main** (no force).

## Risks

1. **HTTP MCP support** — gates step 10. Falls back to stdio per-session.
2. **PGLite single-writer** — gbrain's job queue handles concurrency. Verify before scheduling crons.
3. **Brain size** — ~97 conversations × 50KB ≈ 5MB raw + embeddings ~100MB. PGLite handles.
4. **Source-of-truth drift** — `~/.nanoclaw/var/agents/*/conversations/` is canonical. GBrain pages = derived index. Never edit pages via gbrain UI; will be overwritten on sync.
5. **Single commit blast radius** — pre-flight: build green, smoke unit tests, then push.

## Rollback

- `git revert` cutover commit
- Restore `~/.nanoclaw/var/agents/*/engrams/` from pre-gbrain tarball
- Remove gbrain entry from mcp.json
- `launchctl unload com.nanoclaw.gbrain.plist`
- Restart nanoclaw

## LOC estimate

~ -2500 / +200. Mostly net deletion.

## Time estimate

1–2 hours if HTTP MCP works first try. Add 30 min if stdio fallback path needed.
