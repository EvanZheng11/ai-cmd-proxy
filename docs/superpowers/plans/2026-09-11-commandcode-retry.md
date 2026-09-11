# CommandCode Request Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Retry CommandCode `/alpha/generate` requests up to five total attempts with a 100ms fixed delay.

**Architecture:** Keep retry orchestration inside `src/commandcode/client.ts`, reusing the prepared payload and temporary directory while rebuilding the upstream request per attempt. Any upstream HTTP, transport, timeout, or NDJSON parsing failure is retryable; caller cancellation stops immediately.

**Tech Stack:** TypeScript, Node.js fetch, Vitest.

---

### Task 1: Add retry behavior tests

**Files:**
- Modify: `test/commandcode-client.test.ts`

- [ ] Add tests asserting a transient failure succeeds on a later attempt, five total fetch calls are the maximum, and parsing failures are retried.
- [ ] Inject fake timers or a sleep dependency if needed so tests do not wait in real time; assert the final error is the last upstream error.
- [ ] Run `npm test -- --run test/commandcode-client.test.ts` and confirm the new tests fail before implementation.

### Task 2: Implement bounded fixed-delay retries

**Files:**
- Modify: `src/commandcode/client.ts`

- [ ] Add constants for `MAX_ATTEMPTS = 5` and `RETRY_DELAY_MS = 100`.
- [ ] Extract the current fetch/status/read flow into a single-attempt operation, then loop up to five times.
- [ ] Retry every failure except an already-aborted caller signal; wait 100ms between attempts.
- [ ] Preserve the last `CommandCodeUpstreamError`, response body, cleanup behavior, and existing logging, adding attempt context where useful.
- [ ] Run `npm test -- --run test/commandcode-client.test.ts` and confirm all client tests pass.

### Task 3: Verify the complete change

**Files:**
- No additional files.

- [ ] Run `npm run typecheck`.
- [ ] Run `npm test`.
- [ ] Inspect `git diff` and verify only the retry implementation, its tests, and design/plan documents changed.
