# Add iMessage Channel

Adds iMessage monitoring to NanoClaw. The channel implementation is already in the codebase (`src/channels/imessage.ts`), controlled by `IMESSAGE_ENABLED=true`. This skill handles the macOS system setup required to read `chat.db`.

## How it works

- `ImsgWatcher.app` — a compiled Swift app that runs `imsg watch` and appends JSON events to `~/.nanoclaw/data/imsg-watch.jsonl`
- NanoClaw polls that file every 2 seconds for new messages
- Sending uses `imsg send` (AppleScript-based, no special permissions needed)
- The app must be granted Full Disk Access so `imsg` can read `~/Library/Messages/chat.db`

## Prerequisites

- `imsg` installed: `brew install nicholasgasior/tap/imsg` (verify: `which imsg`)
- Xcode Command Line Tools: `xcode-select --install` (verify: `which swiftc`)

## Setup

Run the setup script — it builds the app, signs it, and installs the LaunchAgent:

```bash
bash scripts/setup-imessage.sh
```

Then the one manual step it can't automate:

1. Open **System Settings > Privacy & Security > Full Disk Access**
2. Click **+** and add `~/Applications/ImsgWatcher.app`
3. Toggle it **ON**

Then activate:

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.imsg-watcher.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Register a chat

Find the numeric chat ID:

```bash
imsg chats --json
```

Add an entry to `~/.nanoclaw/data/registered_agents.json`:

```json
"imsg:<chatID>": {
  "name": "Family",
  "folder": "coco",
  "trigger": "@CoCo",
  "added_at": "2026-01-01T00:00:00.000Z"
}
```

- `folder` — which agent handles it (`main`, `coco`, or a new one)
- `trigger` — mention that activates the agent; leave `""` to respond to all messages

## Verify it's working

```bash
# Watcher running?
launchctl list com.nanoclaw.imsg-watcher   # LastExitStatus should be 0

# Messages being captured?
tail -f ~/.nanoclaw/data/imsg-watch.jsonl

# Send a trigger message in the group, then check nanoclaw logs:
tail -f /path/to/nanoclaw/logs/nanoclaw.log | grep -i imsg
```

## Troubleshooting

**Watcher exits immediately (LastExitStatus=256)**: Full Disk Access not granted or not toggled on for `ImsgWatcher.app`.

**App rejected by FDA picker**: The app must be the compiled binary version (not a shell script). Re-run `scripts/setup-imessage.sh` to recompile.

**Messages not triggering agent**: Check that `IMESSAGE_ENABLED=true` is in `~/.nanoclaw/.env` and nanoclaw was restarted after adding it.

**brew formula path changed** (e.g. after imsg upgrade): Re-run `scripts/setup-imessage.sh` — it recompiles the binary with the current `imsg` path.

## Re-running setup

The script is idempotent — safe to re-run after `imsg` upgrades or on a new machine.
