#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

export PATH="/data/data/com.termux/files/usr/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_JS="$SCRIPT_DIR/server.mjs"
STATE_DIR="$HOME/.config/termux-git-bridge"
PIDFILE="$STATE_DIR/bridge.pid"
LOCKFILE="$STATE_DIR/bridge.lock"
LOGFILE="$STATE_DIR/bridge.log"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

pick_runtime() {
  if command -v node >/dev/null 2>&1 && node -e "" >/dev/null 2>&1; then
    echo "node"
  elif command -v bun >/dev/null 2>&1; then
    echo "bun"
  else
    echo "Error: neither a working node nor bun runtime was found." >&2
    exit 1
  fi
}

is_bridge_running() {
  if [ ! -f "$PIDFILE" ]; then
    return 1
  fi
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  if [ -r "/proc/$pid/cmdline" ] && ! tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q "server.mjs"; then
    return 1
  fi
  return 0
}

(
  flock -x 9
  if is_bridge_running; then
    echo "Termux Git Bridge already running (PID $(cat "$PIDFILE"))."
  else
    RUNTIME="$(pick_runtime)"
    nohup "$RUNTIME" "$SERVER_JS" >> "$LOGFILE" 2>&1 < /dev/null 9>&- &
    echo $! > "$PIDFILE"
    echo "Started Termux Git Bridge with $RUNTIME (PID $!)."
  fi
) 9>"$LOCKFILE"

exec axs "$@"
