#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

export PATH="/data/data/com.termux/files/usr/bin:$PATH"

SERVER_JS="$HOME/termux-git-scm/bridge/server.mjs"
STATE_DIR="$HOME/.config/termux-git-bridge"
PIDFILE="$STATE_DIR/bridge.pid"
LOCKFILE="$STATE_DIR/bridge.lock"
LOGFILE="$STATE_DIR/bridge.log"

[ -f "$SERVER_JS" ] || exit 0

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

if command -v node >/dev/null 2>&1 && node -e "" >/dev/null 2>&1; then
  RUNTIME="node"
elif command -v bun >/dev/null 2>&1; then
  RUNTIME="bun"
else
  exit 1
fi

(
  flock -x 9
  if [ -f "$PIDFILE" ]; then
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "server.mjs"; then
      exit 0
    fi
  fi
  nohup "$RUNTIME" "$SERVER_JS" >> "$LOGFILE" 2>&1 < /dev/null 9>&- &
  echo $! > "$PIDFILE"
) 9>"$LOCKFILE"
