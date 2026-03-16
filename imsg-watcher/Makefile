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

install: build
	@echo "ImsgWatcher.app installed to $(APP_DIR)"
	@echo "Grant Full Disk Access to ImsgWatcher.app in System Settings"

clean:
	rm -rf $(APP_DIR)
