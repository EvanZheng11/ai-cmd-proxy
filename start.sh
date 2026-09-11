#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PID_FILE="$SCRIPT_DIR/.ai-cmd-proxy.pid"
LOG_FILE="$SCRIPT_DIR/.ai-cmd-proxy.log"

if ! command -v npm >/dev/null 2>&1; then
  printf 'Error: npm is required but was not found.\n' >&2
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  pid=$(<"$PID_FILE")
  if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null; then
    printf 'Error: service is already running with PID %s.\n' "$pid" >&2
    exit 1
  fi
  rm -f -- "$PID_FILE"
fi

printf 'Building project...\n'
cd "$SCRIPT_DIR"
npm run build

printf 'Starting service...\n'
nohup npm start </dev/null >>"$LOG_FILE" 2>&1 &
printf '%s\n' "$!" >"$PID_FILE"

printf 'Service started with PID %s. Logs: %s\n' "$(<"$PID_FILE")" "$LOG_FILE"
