---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate WhatsApp, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run all commands automatically. Only pause when user action is required (scanning QR codes).

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text. This integrates with Codex's built-in question/answer system for a better experience.

## 1. Install Dependencies

```bash
npm install
```

Also ensure Codex CLI is installed globally (required for the agent SDK):

```bash
which Codex || npm install -g @anthropic-ai/Codex
Codex --version
```

## 2. Configure Codex Authentication

Ask the user:

> Do you want to use your **Codex subscription** (Pro/Max) or an **Anthropic API key**?

### Option 1: Codex Subscription (Recommended)

Tell the user:

> Open another terminal window and run:
>
> ```
> Codex setup-token
> ```
>
> A browser window will open for you to log in. Once authenticated, the token will be displayed in your terminal. Either:
>
> 1. Paste it here and I'll add it to `.env` for you, or
> 2. Add it to `.env` yourself as `CLAUDE_CODE_OAUTH_TOKEN=<your-token>`

If they give you the token, add it to `.env`:

```bash
echo "CLAUDE_CODE_OAUTH_TOKEN=<token>" > .env
```

### Option 2: API Key

Ask if they have an existing key to copy or need to create one.

**Copy existing:**

```bash
grep "^ANTHROPIC_API_KEY=" /path/to/source/.env > .env
```

**Create new:**

```bash
echo 'ANTHROPIC_API_KEY=' > .env
```

Tell the user to add their key from https://console.anthropic.com/

**Verify:**

```bash
KEY=$(grep "^ANTHROPIC_API_KEY=" .env | cut -d= -f2)
[ -n "$KEY" ] && echo "API key configured: ${KEY:0:10}...${KEY: -4}" || echo "Missing"
```

## 3. WhatsApp Authentication

**USER ACTION REQUIRED**

Run the authentication script:

```bash
npm run auth
```

Tell the user:

> A QR code will appear. On your phone:
>
> 1. Open WhatsApp
> 2. Tap **Settings → Linked Devices → Link a Device**
> 3. Scan the QR code

Wait for the script to output "Successfully authenticated" then continue.

If it says "Already authenticated", skip to the next step.

## 4. Configure Assistant Name

Ask the user:

> What trigger word do you want to use? (default: `Andy`)
>
> Messages starting with `@TriggerWord` will be sent to Codex.

If they choose something other than `Andy`, set `ASSISTANT_NAME=NewName` in `~/.nanoclaw/.env`. Then update any "Andy" references in:

1. `~/.nanoclaw/context/SOUL.md` (persona)
2. `~/.nanoclaw/agents/main/IDENTITY.md` (main agent identity)
3. `~/.nanoclaw/data/registered_agents.json` — set `"trigger": "@NewName"` when registering agents

Store their choice — you'll use it when creating `registered_agents.json` and when telling them how to test.

## 5. Understand the Security Model

Before registering your main channel, you need to understand an important security concept.

**Use the AskUserQuestion tool** to present this:

> **Important: Your "main" channel is your admin control portal.**
>
> The main channel has elevated privileges:
>
> - Can see messages from ALL other registered groups
> - Can manage and delete tasks across all groups
> - Can write to global memory that all groups can read
> - Has read-write access to the entire NanoClaw project
>
> **Recommendation:** Use your personal "Message Yourself" chat or a solo WhatsApp group as your main channel. This ensures only you have admin control.
>
> **Question:** Which setup will you use for your main channel?
>
> Options:
>
> 1. Personal chat (Message Yourself) - Recommended
> 2. Solo WhatsApp group (just me)
> 3. Group with other people (I understand the security implications)

If they choose option 3, ask a follow-up:

> You've chosen a group with other people. This means everyone in that group will have admin privileges over NanoClaw.
>
> Are you sure you want to proceed? The other members will be able to:
>
> - Read messages from your other registered chats
> - Schedule and manage tasks
>
> Options:
>
> 1. Yes, I understand and want to proceed
> 2. No, let me use a personal chat or solo group instead

## 6. Register Main Channel

Ask the user:

> Do you want to use your **personal chat** (message yourself) or a **WhatsApp group** as your main control channel?

For personal chat:

> Send any message to yourself in WhatsApp (the "Message Yourself" chat). Tell me when done.

For group:

> Send any message in the WhatsApp group you want to use as your main channel. Tell me when done.

After user confirms, start the app briefly to capture the message:

```bash
timeout 10 npm run dev || true
```

Then find the JID from the database:

```bash
# For personal chat (ends with @s.whatsapp.net)
sqlite3 ~/.nanoclaw/store/messages.db "SELECT DISTINCT chat_jid FROM messages WHERE chat_jid LIKE '%@s.whatsapp.net' ORDER BY timestamp DESC LIMIT 5"

# For group (ends with @g.us)
sqlite3 ~/.nanoclaw/store/messages.db "SELECT DISTINCT chat_jid FROM messages WHERE chat_jid LIKE '%@g.us' ORDER BY timestamp DESC LIMIT 5"
```

Create/update `~/.nanoclaw/data/registered_agents.json` using the JID from above and the assistant name from step 4:

```json
{
  "JID_HERE": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "CURRENT_ISO_TIMESTAMP"
  }
}
```

Ensure the agent folder exists:

```bash
mkdir -p ~/.nanoclaw/agents/main/logs
```

## 7. Configure launchd Service

Generate the plist file with correct paths automatically:

```bash
NODE_PATH=$(which node)
PROJECT_PATH=$(pwd)
HOME_PATH=$HOME

cat > ~/Library/LaunchAgents/com.nanoclaw.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${PROJECT_PATH}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_PATH}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${HOME_PATH}/.bun/bin:${HOME_PATH}/.orbstack/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${HOME_PATH}/.local/bin</string>
        <key>HOME</key>
        <string>${HOME_PATH}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.error.log</string>
</dict>
</plist>
EOF

echo "Created launchd plist with:"
echo "  Node: ${NODE_PATH}"
echo "  Project: ${PROJECT_PATH}"
```

Build and start the service:

```bash
npm run build
mkdir -p logs
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

Verify it's running:

```bash
launchctl list | grep nanoclaw
```

## 8. Test

Tell the user (using the assistant name they configured):

> Send `@ASSISTANT_NAME hello` in your registered chat.

Check the logs:

```bash
tail -f logs/nanoclaw.log
```

The user should receive a response in WhatsApp.

## Troubleshooting

**Service not starting**: Check `logs/nanoclaw.error.log`

**Agent fails**:

- Check agent logs: `cat ~/.nanoclaw/agents/main/logs/agent-*.log | tail -50`
- Ensure `.env` has valid credentials

**No response to messages**:

- Verify the trigger pattern matches (e.g., `@AssistantName` at start of message)
- Check that the chat JID is in `~/.nanoclaw/data/registered_agents.json`
- Check `logs/nanoclaw.log` for errors

**WhatsApp disconnected**:

- The service will show a macOS notification
- Run `npm run auth` to re-authenticate
- Restart the service: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

**Unload service**:

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```
