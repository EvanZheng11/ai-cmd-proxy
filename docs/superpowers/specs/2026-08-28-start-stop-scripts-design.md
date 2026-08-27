# Start And Stop Scripts Design

## Goal

Provide reliable project-root scripts for building, starting, and stopping the proxy in production mode.

## Scope

- Add `start.sh` and `stop.sh` at the repository root.
- Keep the scripts independent of the caller's current working directory.
- Use `npm run build` followed by `npm start` for startup.
- Run the service in the background and return control to the caller.
- Track the launched process with a project-local `.ai-cmd-proxy.pid` file.
- Capture service output in a project-local log file for troubleshooting.
- Ignore runtime PID and log files in Git.
- Document the commands in `README.md`.

## Startup Behavior

`start.sh` resolves its own directory and runs all commands from that directory. It verifies that `npm` is available, runs `npm run build`, and stops if compilation fails. Before launching, it reads the PID file when present. If that PID still belongs to a running process, startup fails without replacing the file. If the PID is stale or invalid, the file is removed.

After a successful build, the script starts `npm start` in the background, redirects standard output and standard error to the project log file, writes the background process PID to `.ai-cmd-proxy.pid`, and exits successfully.

## Shutdown Behavior

`stop.sh` resolves its own directory and reads the project PID file. For a valid running PID, it sends `TERM` and waits for the process to exit. If the process does not exit within the bounded wait period, it sends `KILL`. The PID file is removed after shutdown.

If the PID file is absent, invalid, or points to a process that is no longer running, the script reports that the service is not running and removes stale state. It must not terminate unrelated processes.

## Error Handling And Safety

- Both scripts use strict shell error handling and quote filesystem paths.
- PID contents are validated as a positive decimal process ID before signaling.
- The PID file is the only process identity source; no broad process-name matching is used.
- Build errors prevent service startup.
- Existing application source changes are outside this task.

## Verification

- Run `bash -n start.sh stop.sh`.
- Run `npm run build` and the existing test suite.
- Start the service with `./start.sh`, verify `/healthz`, and confirm the PID file exists.
- Stop it with `./stop.sh`, confirm the process exits, and confirm the PID file is removed.
- Confirm runtime files are ignored by Git.
