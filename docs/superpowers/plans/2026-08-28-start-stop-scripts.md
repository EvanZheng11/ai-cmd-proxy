# Start And Stop Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add production-mode `start.sh` and `stop.sh` scripts that safely manage one background proxy process using a PID file.

**Architecture:** The root scripts resolve their own directory, so they work from any caller directory. `start.sh` builds the TypeScript project, rejects duplicate live PIDs, starts `npm start` in the background with output redirected to `.ai-cmd-proxy.log`, and records the launched PID in `.ai-cmd-proxy.pid`; `stop.sh` validates that PID, sends `TERM`, waits, escalates to `KILL` if needed, and removes stale runtime state.

**Tech Stack:** POSIX-compatible Bash, npm, Node.js, TypeScript project scripts, Git.

---

### Task 1: Add Runtime File Ignore Rules

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add the PID and log files to `.gitignore`**

Append these exact entries:

```gitignore
.ai-cmd-proxy.pid
.ai-cmd-proxy.log
```

- [ ] **Step 2: Verify the ignore rules**

Run: `git check-ignore -v .ai-cmd-proxy.pid .ai-cmd-proxy.log`

Expected: both paths are reported as ignored by `.gitignore`.

### Task 2: Implement Production Startup

**Files:**
- Create: `start.sh`

- [ ] **Step 1: Create the executable startup script**

Use this implementation:

```bash
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
```

- [ ] **Step 2: Mark `start.sh` executable**

Run: `chmod +x start.sh`

- [ ] **Step 3: Check startup script syntax**

Run: `bash -n start.sh`

Expected: exit code `0` and no output.

### Task 3: Implement Graceful Shutdown

**Files:**
- Create: `stop.sh`

- [ ] **Step 1: Create the executable shutdown script**

Use this implementation:

```bash
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
```

- [ ] **Step 2: Mark `stop.sh` executable**

Run: `chmod +x stop.sh`

- [ ] **Step 3: Check shutdown script syntax**

Run: `bash -n stop.sh`

Expected: exit code `0` and no output.

### Task 4: Document Script Usage

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add production startup and shutdown commands**

Add a section after the existing `## Run` section:

```markdown
### Background Service

Build and start the proxy in the background:

```bash
./start.sh
```

Stop the process started by the script:

```bash
./stop.sh
```

The service PID is stored in `.ai-cmd-proxy.pid` and output is written to `.ai-cmd-proxy.log`.
```

- [ ] **Step 2: Verify documentation references the actual files**

Run: `git diff -- README.md`

Expected: the documented commands are exactly `./start.sh` and `./stop.sh`, and the runtime file names match the scripts.

### Task 5: End-To-End Verification

**Files:**
- Verify: `start.sh`, `stop.sh`, `.gitignore`, `README.md`

- [ ] **Step 1: Run shell syntax checks**

Run: `bash -n start.sh stop.sh`

Expected: exit code `0`.

- [ ] **Step 2: Run project build and tests**

Run: `npm run build && npm test`

Expected: build succeeds and all existing Vitest tests pass.

- [ ] **Step 3: Start the background service**

Run: `./start.sh`

Expected: build succeeds, a positive PID is written to `.ai-cmd-proxy.pid`, and `.ai-cmd-proxy.log` is created or updated.

- [ ] **Step 4: Verify the health endpoint**

Run: `curl --fail --silent http://127.0.0.1:3000/healthz`

Expected: the request succeeds with the service's healthy response.

- [ ] **Step 5: Stop the background service**

Run: `./stop.sh`

Expected: the service exits and `.ai-cmd-proxy.pid` is removed.

- [ ] **Step 6: Verify runtime files remain untracked**

Run: `git status --short --ignored`

Expected: `.ai-cmd-proxy.pid` and `.ai-cmd-proxy.log`, if present, are shown as ignored rather than untracked.

- [ ] **Step 7: Review the final diff**

Run: `git diff --check && git diff -- .gitignore README.md start.sh stop.sh docs/superpowers/specs/2026-08-28-start-stop-scripts-design.md docs/superpowers/plans/2026-08-28-start-stop-scripts.md`

Expected: no whitespace errors and only the intended files are changed. Do not commit unless the user explicitly requests it and Git identity is configured.
