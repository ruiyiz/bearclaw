#!/bin/bash
# Sisyphus — nanoclaw health check monitor
# Runs independently via launchd, alerts via iMessage
# Named after the guy who never stops checking

set -euo pipefail

NANOCLAW_HOME="$HOME/.nanoclaw"
DB_PATH="$NANOCLAW_HOME/store/messages.db"
STATE_FILE="$NANOCLAW_HOME/data/sisyphus_state.json"
IMSG="/opt/homebrew/bin/imsg"
SQLITE="/usr/bin/sqlite3"
ALERT_TO="+18046155370"
LOG_FILE="$HOME/Developer/Repos/oss/nanoclaw/logs/sisyphus.log"

# Staleness threshold: if an active cron handler hasn't fired
# in 2x its interval, it's considered stale
STALE_MULTIPLIER=3
# Max unprocessed events before alerting
MAX_UNPROCESSED=50

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"
}

alert() {
  local msg="[Sisyphus] $1"
  log "ALERT: $msg"
  "$IMSG" send --to "$ALERT_TO" --text "$msg" --service imessage --json 2>/dev/null || \
    log "ERROR: Failed to send iMessage alert"
}

# Initialize state file if it doesn't exist
init_state() {
  if [ ! -f "$STATE_FILE" ]; then
    echo '{"last_alert":{},"consecutive_failures":0}' > "$STATE_FILE"
  fi
}

# Read a value from state JSON
read_state() {
  python3 -c "import json; d=json.load(open('$STATE_FILE')); print(d.get('$1', '$2'))" 2>/dev/null || echo "$2"
}

# Write state
write_state() {
  python3 -c "
import json, sys
try:
    d = json.load(open('$STATE_FILE'))
except:
    d = {}
d['$1'] = $2
json.dump(d, open('$STATE_FILE', 'w'))
" 2>/dev/null
}

# Deduplicate alerts: don't send the same alert within cooldown period
should_alert() {
  local key="$1"
  local cooldown_sec="${2:-3600}"  # default 1 hour cooldown
  local last
  last=$(python3 -c "
import json
d = json.load(open('$STATE_FILE'))
print(d.get('last_alert', {}).get('$key', '0'))
" 2>/dev/null || echo "0")

  local now
  now=$(date +%s)
  local diff=$((now - last))
  if [ "$diff" -ge "$cooldown_sec" ]; then
    # Update last alert time
    python3 -c "
import json, time
d = json.load(open('$STATE_FILE'))
if 'last_alert' not in d: d['last_alert'] = {}
d['last_alert']['$key'] = int(time.time())
json.dump(d, open('$STATE_FILE', 'w'))
" 2>/dev/null
    return 0  # should alert
  fi
  return 1  # suppressed
}

alerts=()

# --- Check 1: Is nanoclaw process running? ---
check_process() {
  if ! pgrep -f "nanoclaw/dist/index.js" > /dev/null 2>&1; then
    alerts+=("process_down|Nanoclaw process is NOT running!")
    log "FAIL: nanoclaw process not found"
  else
    log "OK: nanoclaw process running"
  fi
}

# --- Check 2: Is the database accessible? ---
check_db() {
  if [ ! -f "$DB_PATH" ]; then
    alerts+=("db_missing|Database file not found at $DB_PATH")
    log "FAIL: database file missing"
    return
  fi

  local result
  result=$("$SQLITE" "$DB_PATH" "SELECT count(*) FROM handlers" 2>&1) || {
    alerts+=("db_locked|Database query failed: $result")
    log "FAIL: database query failed: $result"
    return
  }
  log "OK: database accessible ($result handlers)"
}

# --- Check 3: Are active cron handlers firing on schedule? ---
check_handlers() {
  if [ ! -f "$DB_PATH" ]; then return; fi

  local stale_handlers
  stale_handlers=$("$SQLITE" "$DB_PATH" "
    SELECT id, cron, last_triggered, trigger_count
    FROM handlers
    WHERE status = 'active' AND cron IS NOT NULL
  " 2>/dev/null) || return

  while IFS='|' read -r hid cron last_triggered trigger_count; do
    [ -z "$hid" ] && continue

    # Skip handlers that have never triggered (newly created)
    if [ -z "$last_triggered" ] || [ "$last_triggered" = "" ]; then
      log "INFO: handler $hid has never triggered yet"
      continue
    fi

    # Calculate expected interval from cron
    local interval_sec
    interval_sec=$(python3 -c "
import re
cron = '$cron'
parts = cron.split()
if len(parts) >= 1:
    m = parts[0]
    h = parts[1] if len(parts) > 1 else '*'
    if m.startswith('*/'):
        print(int(m[2:]) * 60)
    elif h.startswith('*/'):
        print(int(h[2:]) * 3600)
    elif m == '0' and h == '*':
        print(3600)
    else:
        print(86400)  # daily fallback
else:
    print(86400)
" 2>/dev/null || echo "3600")

    # Check if last_triggered is stale
    local stale_threshold=$((interval_sec * STALE_MULTIPLIER))
    local is_stale
    is_stale=$(python3 -c "
from datetime import datetime, timezone, timedelta
last = datetime.fromisoformat('$last_triggered'.replace('Z', '+00:00'))
now = datetime.now(timezone.utc)
diff = (now - last).total_seconds()
print('stale' if diff > $stale_threshold else 'ok')
" 2>/dev/null || echo "unknown")

    if [ "$is_stale" = "stale" ]; then
      alerts+=("handler_stale_${hid}|Handler '$hid' is stale (last fired: $last_triggered, expected every ${interval_sec}s)")
      log "FAIL: handler $hid is stale"
    else
      log "OK: handler $hid on schedule"
    fi
  done <<< "$stale_handlers"
}

# --- Check 4: Event queue backlog ---
check_event_queue() {
  if [ ! -f "$DB_PATH" ]; then return; fi

  local unprocessed
  unprocessed=$("$SQLITE" "$DB_PATH" "SELECT count(*) FROM events WHERE processed = 0" 2>/dev/null) || return

  if [ "$unprocessed" -gt "$MAX_UNPROCESSED" ]; then
    alerts+=("event_backlog|Event queue backlog: $unprocessed unprocessed events")
    log "FAIL: event queue backlog ($unprocessed)"
  else
    log "OK: event queue clean ($unprocessed unprocessed)"
  fi
}

# --- Check 5: Recent message activity (WhatsApp connected) ---
check_whatsapp() {
  if [ ! -f "$DB_PATH" ]; then return; fi

  local last_msg
  last_msg=$("$SQLITE" "$DB_PATH" "SELECT max(timestamp) FROM messages" 2>/dev/null) || return

  if [ -z "$last_msg" ] || [ "$last_msg" = "" ]; then
    log "INFO: no messages in DB"
    return
  fi

  local hours_ago
  hours_ago=$(python3 -c "
from datetime import datetime, timezone
try:
    last = datetime.fromisoformat('$last_msg'.replace('Z', '+00:00'))
    now = datetime.now(timezone.utc)
    print(f'{(now - last).total_seconds() / 3600:.1f}')
except:
    print('unknown')
" 2>/dev/null || echo "unknown")

  if [ "$hours_ago" != "unknown" ]; then
    local threshold=6
    local is_stale
    is_stale=$(python3 -c "print('stale' if float('$hours_ago') > $threshold else 'ok')" 2>/dev/null || echo "unknown")
    if [ "$is_stale" = "stale" ]; then
      alerts+=("whatsapp_silent|No WhatsApp messages in ${hours_ago}h — connection may be down")
      log "WARN: no messages in ${hours_ago}h"
    else
      log "OK: WhatsApp active (last message ${hours_ago}h ago)"
    fi
  fi
}

# --- Main ---
main() {
  log "--- Sisyphus health check starting ---"
  init_state

  check_process
  check_db
  check_handlers
  check_event_queue
  check_whatsapp

  if [ ${#alerts[@]} -eq 0 ]; then
    log "All checks passed"
    write_state "consecutive_failures" "0"
  else
    local failures
    failures=$(read_state "consecutive_failures" "0")
    failures=$((failures + 1))
    write_state "consecutive_failures" "$failures"

    for entry in "${alerts[@]}"; do
      local key="${entry%%|*}"
      local msg="${entry#*|}"
      if should_alert "$key" 3600; then
        alert "$msg"
      else
        log "SUPPRESSED: $msg (cooldown active)"
      fi
    done
  fi

  log "--- Sisyphus health check complete ---"
}

main
