#!/usr/bin/env bash
# Setup iMessage channel: builds ImsgWatcher.app, installs LaunchAgent, enables channel.
set -euo pipefail

NANOCLAW_HOME="${NANOCLAW_HOME:-$HOME/.nanoclaw}"
APP_DIR="$HOME/Applications"
APP_PATH="$APP_DIR/ImsgWatcher.app"
BINARY_PATH="$APP_PATH/Contents/MacOS/ImsgWatcher"
PLIST_PATH="$HOME/Library/LaunchAgents/com.nanoclaw.imsg-watcher.plist"
ENV_FILE="$NANOCLAW_HOME/.env"
WATCH_FILE="$NANOCLAW_HOME/data/imsg-watch.jsonl"

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

# Create app bundle structure
echo "--> Creating ImsgWatcher.app"
mkdir -p "$APP_PATH/Contents/MacOS"

# Write Info.plist
cat > "$APP_PATH/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.nanoclaw.imsg-watcher</string>
    <key>CFBundleName</key>
    <string>ImsgWatcher</string>
    <key>CFBundleExecutable</key>
    <string>ImsgWatcher</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
    <key>LSBackgroundOnly</key>
    <true/>
</dict>
</plist>
PLIST

# Compile Swift binary
echo "--> Compiling binary"
SWIFT_SRC=$(mktemp /tmp/ImsgWatcher.XXXXXX.swift)
cat > "$SWIFT_SRC" << 'SWIFT'
import Foundation

let home = FileManager.default.homeDirectoryForCurrentUser.path
let outputPath = "\(home)/.nanoclaw/data/imsg-watch.jsonl"

try? FileManager.default.createDirectory(
    atPath: "\(home)/.nanoclaw/data",
    withIntermediateDirectories: true
)

guard let outputFile = FileHandle(forWritingAtPath: outputPath) ?? {
    FileManager.default.createFile(atPath: outputPath, contents: nil)
    return FileHandle(forWritingAtPath: outputPath)
}() else {
    exit(1)
}
outputFile.seekToEndOfFile()

let proc = Process()
proc.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/imsg")
proc.arguments = ["watch", "--json", "--attachments"]
proc.standardOutput = outputFile
proc.standardError = FileHandle.nullDevice

try! proc.run()
proc.waitUntilExit()
SWIFT

swiftc "$SWIFT_SRC" -o "$BINARY_PATH"
rm "$SWIFT_SRC"

# Sign with FDA entitlement
echo "--> Signing app"
ENTITLEMENTS=$(mktemp /tmp/imsg-entitlements.XXXXXX.plist)
cat > "$ENTITLEMENTS" << 'ENT'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.files.all</key>
    <true/>
</dict>
</plist>
ENT
codesign --force --sign - --options runtime --entitlements "$ENTITLEMENTS" "$APP_PATH"
rm "$ENTITLEMENTS"

# Install LaunchAgent
echo "--> Installing LaunchAgent"
cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.imsg-watcher</string>
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
  echo "IMESSAGE_ENABLED=true" >> "$ENV_FILE"
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
echo "    launchctl kickstart -k gui/\$(id -u)/com.nanoclaw"
echo ""
echo "==> To register a chat, find its ID with:  imsg chats --json"
echo "    Then add an entry to $NANOCLAW_HOME/data/registered_agents.json:"
echo '    "imsg:<chatID>": { "name": "Name", "folder": "coco", "trigger": "@CoCo", "added_at": "..." }'
