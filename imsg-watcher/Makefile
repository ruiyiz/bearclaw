APP_DIR    := $(HOME)/Applications/ImsgWatcher.app
BINARY     := $(APP_DIR)/Contents/MacOS/ImsgWatcher
PLIST_SRC  := Info.plist
PLIST_DST  := $(APP_DIR)/Contents/Info.plist

.PHONY: build install clean

build: $(BINARY)

$(BINARY): main.swift
	@mkdir -p $(APP_DIR)/Contents/MacOS
	swiftc $< -o $@ -lsqlite3
	@cp $(PLIST_SRC) $(PLIST_DST)
	codesign --force --sign - --options runtime $(APP_DIR)
	@echo ""
	@echo "*** Ad-hoc re-signing invalidated Full Disk Access. ***"
	@echo "Re-grant it or launchd will exit(1) and iMessage stops receiving:"
	@echo "  1. remove + re-add ImsgWatcher.app in the FDA pane (opening now)"
	@echo "  2. launchctl kickstart -k gui/$$(id -u)/com.bearclaw.imsg-watcher"
	@open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" || true

install: build
	@echo "ImsgWatcher.app installed to $(APP_DIR)"
	@echo "Grant Full Disk Access to ImsgWatcher.app in System Settings"

clean:
	rm -rf $(APP_DIR)
