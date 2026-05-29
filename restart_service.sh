#!/bin/bash
npm run build && launchctl unload ~/Library/LaunchAgents/com.bearclaw.plist && launchctl load ~/Library/LaunchAgents/com.bearclaw.plist
