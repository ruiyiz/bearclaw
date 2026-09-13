#!/bin/sh

# node-pty 1.1.0's macOS package can lose this executable bit.
find node_modules/node-pty/prebuilds -path '*/spawn-helper' -type f -exec chmod +x {} + 2>/dev/null || true
