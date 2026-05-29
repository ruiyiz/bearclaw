#!/usr/bin/env bash
# Setup iMessage channel: builds ImsgWatcher.app, installs LaunchAgent, enables channel.
set -euo pipefail

BEARCLAW_HOME="${BEARCLAW_HOME:-$HOME/.bearclaw}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH="$HOME/Applications/ImsgWatcher.app"
BINARY_PATH="$APP_PATH/Contents/MacOS/ImsgWatcher"
PLIST_PATH="$HOME/Library/LaunchAgents/com.bearclaw.imsg-watcher.plist"
ENV_FILE="$BEARCLAW_HOME/.env"

echo "==> Setting up iMessage channel"

# Check prerequisites
if ! command -v imsg &>/dev/null; then
	echo "ERROR: imsg not found. Install with: brew install nicholasgasior/tap/imsg"
	exit 1
fi
if ! command -v swiftc &>/dev/null; then
	echo "ERROR: swiftc not found. Install Xcode Command Line Tools: xcode-select --install"
	exit 1
fi

# Build ImsgWatcher.app
echo "--> Building ImsgWatcher.app"
make -C "$REPO_DIR/imsg-watcher" build

# Install LaunchAgent
echo "--> Installing LaunchAgent"
cat >"$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.bearclaw.imsg-watcher</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BINARY_PATH</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
PLIST

# Enable in .env
echo "--> Enabling IMESSAGE_ENABLED in $ENV_FILE"
if grep -q "^IMESSAGE_ENABLED=" "$ENV_FILE" 2>/dev/null; then
	sed -i '' 's/^IMESSAGE_ENABLED=.*/IMESSAGE_ENABLED=true/' "$ENV_FILE"
else
	echo "IMESSAGE_ENABLED=true" >>"$ENV_FILE"
fi

echo ""
echo "==> Almost done. One manual step required:"
echo ""
echo "    1. Open System Settings > Privacy & Security > Full Disk Access"
echo "    2. Click + and add: $APP_PATH"
echo "    3. Toggle it ON"
echo ""
echo "    Then run:"
echo "    launchctl load $PLIST_PATH"
echo "    launchctl kickstart -k gui/\$(id -u)/com.bearclaw"
echo ""
echo "==> To register a chat, find its ID with:  imsg chats --json"
echo "    Then add an entry to $BEARCLAW_HOME/data/registered_agents.json:"
echo '    "imsg:<chatID>": { "name": "Name", "folder": "coco", "trigger": "@CoCo", "added_at": "..." }'
