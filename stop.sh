#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PID_FILE="$SCRIPT_DIR/.ai-cmd-proxy.pid"

if [[ ! -f "$PID_FILE" ]]; then
  printf 'Service is not running (PID file not found).\n'
  exit 0
fi

pid=$(<"$PID_FILE")
if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]]; then
  printf 'Removing invalid PID file.\n' >&2
  rm -f -- "$PID_FILE"
  exit 1
fi

if ! kill -0 "$pid" 2>/dev/null; then
  printf 'Service is not running; removing stale PID file.\n'
  rm -f -- "$PID_FILE"
  exit 0
fi

kill -TERM "$pid"
for _ in {1..20}; do
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f -- "$PID_FILE"
    printf 'Service stopped.\n'
    exit 0
  fi
  sleep 0.25
done

printf 'Service did not stop gracefully; sending SIGKILL.\n' >&2
kill -KILL "$pid" 2>/dev/null || true
rm -f -- "$PID_FILE"
printf 'Service stopped.\n'
