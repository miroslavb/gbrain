#!/bin/bash
# Host watchdog for the production gbrain autopilot daemon.
#
# The systemd user unit is the only owner whenever it is installed. Cron may
# health-trigger that unit, but it must never bypass an operator mask or launch
# a second detached daemon while systemd owns the lifecycle.
UNIT_NAME=gbrain-autopilot.service
USER_SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
RUNTIME_SYSTEMD_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/systemd/user"
USER_UNIT="$USER_SYSTEMD_DIR/$UNIT_NAME"
RUNTIME_UNIT="$RUNTIME_SYSTEMD_DIR/$UNIT_NAME"

# A mask is an intentional operator fence. `systemctl --user cat` exits nonzero
# for a masked unit, so test mask symlinks before using `cat` for discovery.
if [ "$(readlink "$USER_UNIT" 2>/dev/null)" = "/dev/null" ] || \
   [ "$(readlink "$RUNTIME_UNIT" 2>/dev/null)" = "/dev/null" ]; then
  exit 0
fi

# The on-disk unit remains authoritative while systemd's manager cache reloads.
# A present unit must never fall through to the direct-launch compatibility path.
if [ -e "$USER_UNIT" ] || [ -L "$USER_UNIT" ] || \
   systemctl --user cat "$UNIT_NAME" >/dev/null 2>&1; then
  UNIT_STATE=$(systemctl --user show "$UNIT_NAME" -p ActiveState --value 2>/dev/null)
  UNIT_PID=$(systemctl --user show "$UNIT_NAME" -p MainPID --value 2>/dev/null)
  if [ "$UNIT_STATE" = "active" ] && [ "${UNIT_PID:-0}" -gt 0 ] 2>/dev/null; then
    AGE=$(ps -o etimes= -p "$UNIT_PID" 2>/dev/null | tr -d ' ')
    if [ "${AGE:-0}" -gt 86400 ]; then
      echo "[watchdog] $(date -Is) systemd daemon PID $UNIT_PID age ${AGE}s > 24h — managed restart" >> /root/.gbrain/autopilot.log
      systemctl --user restart "$UNIT_NAME"
    fi
    exit 0
  fi

  # During RestartSec, or while a legacy detached owner still holds the lock,
  # never race systemd by launching the wrapper ourselves.
  if [ "$UNIT_STATE" = "activating" ] || \
     pgrep -f '^bun /root/.bun/bin/gbrain autopilot --repo /root/gbrain$' >/dev/null 2>&1; then
    exit 0
  fi
  systemctl --user start "$UNIT_NAME"
  exit $?
fi

# Compatibility fallback for hosts with no user unit at all.
PID=$(pgrep -f 'bin/gbrain autopilot --repo' | head -1)
if [ -n "$PID" ]; then
  AGE=$(ps -o etimes= -p "$PID" 2>/dev/null | tr -d ' ')
  if [ "${AGE:-0}" -gt 86400 ]; then
    echo "[watchdog] $(date -Is) daemon PID $PID age ${AGE}s > 24h — preemptive restart" >> /root/.gbrain/autopilot.log
    kill -TERM "$PID" 2>/dev/null
    sleep 5
    kill -KILL "$PID" 2>/dev/null
    pkill -TERM -f 'gbrain jobs work' 2>/dev/null
    sleep 2
    rm -f /root/.gbrain/autopilot.lock
  fi
fi

if ! pgrep -f 'bin/gbrain autopilot --repo' >/dev/null 2>&1; then
  rm -f /root/.gbrain/autopilot.lock
  /root/.gbrain/autopilot-run.sh >> /root/.gbrain/autopilot.log 2>&1
fi
