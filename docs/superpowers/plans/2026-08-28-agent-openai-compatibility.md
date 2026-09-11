# Agent OpenAI Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing CommandCode adapter reliable as an OpenAI-compatible upstream for sub2api consumers including OpenCode, Codex CLI, and Claude Code.

**Architecture:** Keep the existing stateless Fastify routes and pure translation modules. Harden the boundary between OpenAI requests, CommandCode NDJSON, and downstream SSE by normalizing all supported input forms, propagating request cancellation, and distinguishing upstream timeout/protocol failures from client disconnects. Do not add a second upstream protocol or persist response history.

**Tech Stack:** Node.js 22, TypeScript, Fastify 5, Zod 4, native `fetch`, Vitest 4.

---

## File Map

- Modify `src/openai/types.ts`: describe the supported Chat Completions and Responses request/content shapes without losing client-provided optional fields needed for translation.
- Modify `src/openai/schemas.ts`: validate the agent-core request subset, including common Responses content and tool shapes, while rejecting malformed values with stable local errors.
- Modify `src/translate/messages.ts`: normalize OpenAI image parts and safely materialize public images without dropping content.
- Modify `src/translate/responses.ts`: normalize Responses input/history and emit complete non-streaming and streaming Responses events.
- Modify `src/translate/chat.ts`: emit OpenAI Chat Completions JSON/SSE semantics for text, tools, usage, finish reasons, and terminal markers.
- Modify `src/commandcode/client.ts`: make HTTP/1.1-compatible upstream streaming, timeout classification, abort propagation, NDJSON termination, and cleanup deterministic.
- Modify `src/routes/chat-completions.ts`: pass the request cancellation signal and safely terminate downstream SSE on disconnect or upstream failure.
- Modify `src/routes/responses.ts`: pass the request cancellation signal and apply the same streaming lifecycle/error rules as Chat Completions.
- Modify `src/errors.ts`: preserve OpenAI error shape and map timeout, cancellation, rate-limit, and upstream statuses consistently.
- Modify `README.md`: document the sub2api deployment topology, supported compatibility surface, image requirements, and timeout/cancellation settings.
- Modify `test/translate.test.ts`, `test/responses.test.ts`, `test/chat-completions.test.ts`, and `test/commandcode-client.test.ts`: add regression coverage before each implementation change.

### Task 1: Establish a baseline and reproduce current behavior

**Files:**
- Test: `test/translate.test.ts`
- Test: `test/responses.test.ts`
- Test: `test/chat-completions.test.ts`
- Test: `test/commandcode-client.test.ts`

- [ ] **Step 1: Run the existing suite and record the baseline.**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected: the current repository tests and build complete. If an existing test fails, document that failure before changing code and preserve unrelated worktree changes.

- [ ] **Step 2: Inspect the current git diff before implementation.**

Run:

```bash
git status --short
git diff -- src/commandcode/client.ts src/translate/messages.ts src/translate/responses.ts src/routes/responses.ts
```

Expected: identify which current uncommitted changes belong to this task; do not reset or overwrite unrelated changes.

### Task 2: Lock down image compatibility at the OpenAI boundary

**Files:**
- Test: `test/translate.test.ts`
- Test: `test/responses.test.ts`
- Modify: `src/openai/types.ts`
- Modify: `src/openai/schemas.ts`
- Modify: `src/translate/messages.ts`
- Modify: `src/translate/responses.ts`

- [ ] **Step 1: Add failing Chat Completions image tests.**

Add tests that pass both of these request forms through `toCommandCodeGenerateRequest`:

```ts
{
  model: "deepseek/deepseek-v4-flash-vision-exp",
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "Describe the image" },
      { type: "image_url", image_url: {
        url: "data:image/png;base64,aGVsbG8=",
        detail: "high",
      } },
    ],
  }],
}
```

and a Responses-style normalized message containing `input_image`. Assert that the generated CommandCode content is exactly:

```ts
{
  type: "image",
  image: "data:image/png;base64,aGVsbG8=",
  mediaType: "image/png",
}
```

Run:

```bash
npx vitest run test/translate.test.ts test/responses.test.ts
```

Expected: the new test fails if an accepted image form is dropped, rejected by schema validation, or converted without `mediaType`.

- [ ] **Step 2: Add failing route-level image forwarding coverage.**

Create a fake `CommandCodeClient` that captures `request.params.messages`, inject a Chat Completions request with a base64 image, and assert the captured message contains the CommandCode image block. Repeat with a public URL using an injected `fetch`/materialization seam and assert the fetched bytes become the expected base64 data URL. Do not use a real network request.

Run:

```bash
npx vitest run test/chat-completions.test.ts test/translate.test.ts
```

Expected: FAIL until the complete route-to-upstream path preserves image content.

- [ ] **Step 3: Implement the smallest image/schema changes.**

Ensure `contentPartSchema` accepts only the OpenAI image URL shape used by this proxy, `normalizeInput` accepts Responses `input_image` and object/string `image_url` forms, and `toContent` converts only validated data URLs into CommandCode image blocks. Keep public URL fetching restricted to `http:`/`https:`, reject private DNS answers and redirects, require `image/*`, and enforce the existing byte cap. Preserve `detail` only at the OpenAI boundary; do not send it to CommandCode because the native block has no such field.

- [ ] **Step 4: Run image tests and the full translation suite.**

Run:

```bash
npx vitest run test/translate.test.ts test/responses.test.ts test/chat-completions.test.ts
```

Expected: PASS, with no image base64 present in diagnostic logs.

### Task 3: Complete Chat Completions and Responses response semantics

**Files:**
- Test: `test/chat-completions.test.ts`
- Test: `test/responses.test.ts`
- Modify: `src/translate/chat.ts`
- Modify: `src/translate/responses.ts`
- Modify: `src/errors.ts`

- [ ] **Step 1: Add failing Chat Completions compatibility tests.**

Cover these event sequences:

```ts
[
  { type: "text-delta", text: "A" },
  { type: "text-delta", text: "B" },
  { type: "finish", finishReason: "end_turn", totalUsage: {
    inputTokens: 4,
    outputTokens: 2,
  } },
]
```

Assert that streaming produces one role chunk, both text deltas in order, one finish chunk, optional usage only when `stream_options.include_usage` is true, and exactly one `[DONE]`. Add a tool-call case and assert increasing tool indexes, valid JSON-string arguments, `finish_reason: "tool_calls"`, and no assistant text content fabricated for a tool-only result.

- [ ] **Step 2: Add failing Responses lifecycle tests.**

For text, reasoning, and function-call events assert event order:

```text
response.created
response.output_item.added
response.content_part.added or response.reasoning_summary_part.added
response.output_text.delta or response.reasoning_summary_text.delta
response.*.done
response.output_item.done
response.completed
```

Assert the final event contains the same response ID/model and usage when upstream usage exists. Add an upstream error case and assert an error event is emitted without a completed event.

- [ ] **Step 3: Implement response aggregation and event-state fixes.**

Keep one generated ID per downstream request, retain usage observed before the finish event, map CommandCode `end_turn`/`max_tokens`/tool-call variants to OpenAI finish reasons, and never emit a successful completion after `error` or `abort`. For streaming, emit terminal events exactly once even if the upstream sends duplicate terminal metadata.

- [ ] **Step 4: Run response tests.**

Run:

```bash
npx vitest run test/chat-completions.test.ts test/responses.test.ts
```

Expected: PASS, including existing behavior for non-streaming JSON responses.

### Task 4: Fix upstream stream timeout and cancellation behavior

**Files:**
- Test: `test/commandcode-client.test.ts`
- Test: `test/chat-completions.test.ts`
- Test: `test/responses.test.ts`
- Modify: `src/commandcode/client.ts`
- Modify: `src/routes/chat-completions.ts`
- Modify: `src/routes/responses.ts`

- [ ] **Step 1: Add a failing slow-stream regression test.**

Use a manually controlled `ReadableStream<Uint8Array>` that enqueues one valid non-terminal event, waits longer than an incorrectly applied per-read timeout, then enqueues a terminal finish event. Configure a request timeout larger than the total delay and assert both events are returned. This proves a healthy long-running Codex stream is not killed between chunks.

Run:

```bash
npx vitest run test/commandcode-client.test.ts -t "slow|stream|timeout"
```

Expected: FAIL if the implementation applies a fresh short read timeout or mishandles the reader after the first chunk.

- [ ] **Step 2: Add failing timeout and abort-signal tests.**

Capture `RequestInit.signal` passed to the mocked upstream `fetch`. Assert that a timeout causes `CommandCodeUpstreamError` with status `504`. Create an external `AbortController`, abort it while the fetch/read is pending, assert the same signal is aborted, and assert the temporary directory removal function is called. Client cancellation must not be remapped as a normal upstream `502`/`504` response in route-level tests.

- [ ] **Step 3: Add failing route disconnect tests.**

Use a controlled async iterator as the fake client and a raw response/request test seam available in Fastify. Start a streaming request, close the downstream connection before the finish event, and assert the iterator's `return`/abort path runs. Ensure no write is attempted after `reply.raw.destroyed` becomes true.

- [ ] **Step 4: Implement request-scoped cancellation and bounded timeout.**

Create one `AbortController` per route request, combine its signal with the configured `AbortSignal.timeout`, and pass the combined signal into `commandCodeClient.stream`. In the upstream client, classify `TimeoutError` as `504`, distinguish caller abort from timeout, always cancel/release the NDJSON reader, and always remove the temporary directory. Keep the timeout as one request budget rather than resetting it for each NDJSON line. Routes must stop downstream writes after disconnect and must not call `reply.code(...).send(...)` after hijacking.

- [ ] **Step 5: Run stream and cancellation tests.**

Run:

```bash
npx vitest run test/commandcode-client.test.ts test/chat-completions.test.ts test/responses.test.ts
```

Expected: PASS for slow streams, timeout mapping, caller cancellation, cleanup, and post-header SSE errors.

### Task 5: Harden OpenAI request validation and error behavior

**Files:**
- Test: `test/routes.test.ts`
- Test: `test/chat-completions.test.ts`
- Test: `test/responses.test.ts`
- Modify: `src/openai/schemas.ts`
- Modify: `src/routes/chat-completions.ts`
- Modify: `src/routes/responses.ts`
- Modify: `src/errors.ts`

- [ ] **Step 1: Add failing validation/error tests.**

Assert all of the following return an OpenAI-shaped body with `message`, `type`, `param`, and `code`:

- missing credential: `401 authentication_error`
- malformed JSON or invalid schema: `400 invalid_request_error`
- unsupported tool selection controls: `400 invalid_request_error`
- upstream `401`: `401 authentication_error`
- upstream `429`: `429 rate_limit_error`
- upstream `5xx`: same server status with `api_error`
- unsupported `/v1/*` endpoint: `501 api_error` with `unsupported_endpoint`

Add a stream test proving an upstream error after headers produces only an SSE error payload and does not attempt a second HTTP response.

- [ ] **Step 2: Implement stable status mapping without leaking upstream secrets.**

Use the existing `openAiError` shape for every route error. Preserve `401` and `429`, map other upstream 4xx to `502` unless the error is a local validation failure, and keep post-header failures inside SSE. Do not include upstream response bodies in downstream errors unless they are explicitly sanitized; never include authorization values or raw image data.

- [ ] **Step 3: Run route/error tests.**

Run:

```bash
npx vitest run test/routes.test.ts test/chat-completions.test.ts test/responses.test.ts test/security.test.ts test/errors.test.ts
```

Expected: PASS with consistent OpenAI error fields and no credential/query/body leaks.

### Task 6: Document deployment and compatibility behavior

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Update the deployment topology documentation.**

Document the supported path exactly as:

```text
OpenCode/Codex CLI/Claude Code -> sub2api -> ai-cmd-proxy -> CommandCode /alpha/generate
```

List the supported endpoints and fields, explain that unsupported OpenAI API groups return `501`, and state that the proxy does not persist `previous_response_id` state.

- [ ] **Step 2: Document image and Codex settings.**

Document that OpenCode model metadata must declare `input: ["text", "image"]`, that images must be data URLs or public HTTP(S) image URLs, and that `REQUEST_TIMEOUT_MS` is a single request budget covering connection and stream reads. Include safe examples using `${COMMAND_CODE_API_KEY}` only; never include a real credential.

- [ ] **Step 3: Verify documentation and configuration examples.**

Run:

```bash
git diff --check
git grep -n -I -E 'user_[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9_-]{20,}' -- README.md .env.example src test docs/superpowers/specs docs/superpowers/plans || true
```

Expected: no whitespace errors and no credential-like literal in documentation or source.

### Task 7: Full verification and review

**Files:**
- Test: all files under `test/`
- Modify: only files listed in previous tasks

- [ ] **Step 1: Run the complete verification commands.**

Run:

```bash
npm test
npm run typecheck
npm run build
```

Expected: all tests pass, TypeScript reports no errors, and the production build succeeds.

- [ ] **Step 2: Inspect the final diff for scope and security.**

Run:

```bash
git status --short
git diff --check
git diff --stat
git diff -- src README.md .env.example test docs/superpowers/plans/2026-08-28-agent-openai-compatibility.md
```

Expected: no unrelated files are reverted, no API key or image contents are added, and the plan/spec/documentation changes match the approved design.

- [ ] **Step 3: Commit only if explicitly requested.**

Before any commit, inspect `git status`, `git diff`, and `git log --oneline -10`; stage only task-owned files. Do not include pre-existing unrelated modifications or generated secrets.
