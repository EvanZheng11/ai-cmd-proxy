# CommandCode OpenAI Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Fastify and TypeScript service that exposes OpenAI-compatible Chat Completions and Responses endpoints while proxying each authenticated request to CommandCode `/alpha/generate`.

**Architecture:** A stateless Fastify server owns HTTP validation and OpenAI-shaped responses. Pure adapter modules translate OpenAI request data into the CommandCode wire format and translate CommandCode newline-delimited JSON events back into OpenAI JSON or SSE; a request-scoped upstream client owns credentials, headers, random temporary working directories, stream parsing, timeouts, and cleanup.

**Tech Stack:** Node.js 22, TypeScript, Fastify, Zod, Vitest, Fastify inject.

**Spec:** `docs/superpowers/specs/2026-08-27-commandcode-openai-proxy-design.md`

## Global Constraints

- Source code lives in `/Users/andyzheng/git/ai-cmd-proxy`.
- Inbound CommandCode credentials are request scoped, never persisted, cached, logged, returned, or committed.
- CommandCode requests use a unique operating-system temporary working directory and remove it after completion or failure.
- Default completion token cap is exactly `1000000`.
- CommandCode upstream route is `/alpha/generate` and always streams newline-delimited JSON.
- Unsupported functionality returns an OpenAI-shaped error instead of a fabricated successful response.
- Production code follows test-driven development: write and observe each test failing before implementation.

---

### Task 1: Project Foundation And OpenAI Errors

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/config.ts`
- Create: `src/errors.ts`
- Create: `src/index.ts`
- Create: `test/errors.test.ts`

**Interfaces:**
- Produces `loadConfig(env): ProxyConfig`.
- Produces `openAiError(status, message, options): OpenAiErrorBody`.
- Produces `start(): Promise<void>` as the executable service entry point.

- [ ] **Step 1: Write the failing tests for defaults and OpenAI error shape**

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openAiError } from "../src/errors.js";

describe("proxy configuration", () => {
  it("uses a one million token default", () => {
    expect(loadConfig({}).defaultMaxTokens).toBe(1_000_000);
  });
});

describe("openAiError", () => {
  it("returns the OpenAI error envelope", () => {
    expect(openAiError(400, "Bad input", { code: "invalid_input" })).toEqual({
      error: {
        message: "Bad input",
        type: "invalid_request_error",
        param: null,
        code: "invalid_input",
      },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- errors.test.ts`

Expected: FAIL because the project files and exports do not exist.

- [ ] **Step 3: Create the TypeScript package and minimal implementation**

```ts
export type ProxyConfig = {
  host: string;
  port: number;
  commandCodeApiUrl: string;
  commandCodeVersion: string;
  defaultMaxTokens: number;
  requestTimeoutMs: number;
  maxRequestBytes: number;
};

export function loadConfig(env: NodeJS.ProcessEnv): ProxyConfig {
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 3000),
    commandCodeApiUrl: env.COMMAND_CODE_API_URL ?? "https://api.commandcode.ai",
    commandCodeVersion: env.COMMAND_CODE_VERSION ?? "1.36.0",
    defaultMaxTokens: Number(env.DEFAULT_MAX_TOKENS ?? 1_000_000),
    requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? 600_000),
    maxRequestBytes: Number(env.MAX_REQUEST_BYTES ?? 20_971_520),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- errors.test.ts`

Expected: PASS with 2 tests.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore .env.example src test
git commit -m "chore: bootstrap proxy service"
```

### Task 2: Request-Scoped CommandCode Client

**Files:**
- Create: `src/auth.ts`
- Create: `src/commandcode/types.ts`
- Create: `src/commandcode/client.ts`
- Create: `test/commandcode-client.test.ts`

**Interfaces:**
- Produces `extractCredential(headers): string`.
- Produces `createCommandCodeClient(dependencies): CommandCodeClient`.
- `CommandCodeClient.stream(request): AsyncIterable<CommandCodeEvent>`.
- Consumes a `CommandCodeGenerateRequest` and sends `POST /alpha/generate`.

- [ ] **Step 1: Write the failing tests for credential extraction, required upstream headers, request-scoped temporary directory, and NDJSON parsing**

```ts
it("prefers a bearer credential and never includes it in log metadata", () => {
  const key = extractCredential({ authorization: "Bearer secret-value" });
  expect(key).toBe("secret-value");
  expect(redactHeaders({ authorization: "Bearer secret-value" })).toEqual({
    authorization: "[REDACTED]",
  });
});

it("sends CommandCode headers and deletes its temporary directory", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response('{"type":"text-delta","text":"OK"}\n{"type":"finish","finishReason":"end_turn"}\n'),
  );
  const removeTempDir = vi.fn();
  const client = createCommandCodeClient({
    config: loadConfig({}),
    fetch: fetchMock,
    createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-test"),
    removeTempDir,
  });

  await collect(client.stream({ apiKey: "secret-value", request: sampleGenerateRequest() }));

  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.commandcode.ai/alpha/generate",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        authorization: "Bearer secret-value",
        "x-command-code-version": "1.36.0",
      }),
    }),
  );
  expect(removeTempDir).toHaveBeenCalledWith("/tmp/ai-cmd-proxy-test");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- commandcode-client.test.ts`

Expected: FAIL because the authentication and CommandCode client modules do not exist.

- [ ] **Step 3: Implement the credential extraction and upstream streaming client**

Implement header extraction from `Authorization: Bearer` followed by `X-CommandCode-API-Key`. Build a fresh `config` object per request, create a temporary directory with `fs.mkdtemp`, use the current date and process platform, stream each nonempty NDJSON line through `JSON.parse`, and remove the directory in `finally`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- commandcode-client.test.ts`

Expected: PASS with header, cleanup, parser, and error-mapping tests.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts src/commandcode test/commandcode-client.test.ts
git commit -m "feat: add CommandCode streaming client"
```

### Task 3: OpenAI Request And Message Translation

**Files:**
- Create: `src/openai/types.ts`
- Create: `src/openai/schemas.ts`
- Create: `src/translate/messages.ts`
- Create: `src/translate/tools.ts`
- Create: `src/translate/generate-request.ts`
- Create: `test/translate.test.ts`

**Interfaces:**
- Produces `parseChatCompletionRequest(input): ChatCompletionRequest`.
- Produces `parseResponsesRequest(input): ResponsesRequest`.
- Produces `toCommandCodeGenerateRequest(input): CommandCodeGenerateRequest`.
- Produces `toCommandCodeTools(input): CommandCodeTool[]`.

- [ ] **Step 1: Write failing translation tests**

```ts
it("maps text, system instructions, and max completion tokens", () => {
  const result = toCommandCodeGenerateRequest(
    chatRequest({
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" },
      ],
      max_completion_tokens: 123,
      model: "deepseek/deepseek-v4-flash",
    }),
  );

  expect(result.mode).toBe("agent");
  expect(result.params.system).toBe("Be concise.");
  expect(result.params.max_tokens).toBe(123);
  expect(result.params.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "Hello" }] },
  ]);
});

it("maps image data URLs and function tools", () => {
  const result = toCommandCodeGenerateRequest(
    chatRequest({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Read this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        ],
      }],
      tools: [{
        type: "function",
        function: {
          name: "lookup",
          description: "Find a record",
          parameters: { type: "object", properties: { id: { type: "string" } } },
        },
      }],
    }),
  );

  expect(result.params.messages[0].content[1]).toMatchObject({
    type: "image",
    media_type: "image/png",
  });
  expect(result.params.tools[0].name).toBe("lookup");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- translate.test.ts`

Expected: FAIL because request parsing and translation modules do not exist.

- [ ] **Step 3: Implement schemas and translations**

Use Zod to reject malformed requests. Implement text, system, developer, assistant, tool, tool-result, image URL, and image data URL conversion. Add `reasoning_effort`, `temperature`, `top_p`, `stop`, `tool_choice`, and `parallel_tool_calls` to the generated CommandCode request where the upstream protocol supports them. Add a system constraint for `json_object` and `json_schema`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- translate.test.ts`

Expected: PASS with text, image, tool, JSON schema, and invalid-content tests.

- [ ] **Step 5: Commit**

```bash
git add src/openai src/translate test/translate.test.ts
git commit -m "feat: translate OpenAI requests to CommandCode"
```

### Task 4: Chat Completions Endpoint And SSE Adapter

**Files:**
- Create: `src/translate/chat.ts`
- Create: `src/routes/chat-completions.ts`
- Create: `src/server.ts`
- Create: `test/chat-completions.test.ts`

**Interfaces:**
- Produces `buildServer(dependencies): FastifyInstance`.
- Produces `toChatCompletion(events, options): ChatCompletion`.
- Produces `toChatCompletionChunks(events, options): AsyncIterable<string>`.

- [ ] **Step 1: Write failing endpoint tests**

```ts
it("returns a non-streaming Chat Completion", async () => {
  const app = buildServer({ commandCodeClient: fakeClient([
    { type: "text-delta", text: "TEST_OK" },
    { type: "finish", finishReason: "end_turn", totalUsage: { inputTokens: 4, outputTokens: 2 } },
  ]) });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer request-key" },
    payload: { model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "Hi" }] },
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    object: "chat.completion",
    choices: [{ message: { content: "TEST_OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  });
});

it("returns [DONE] after streaming chat completion chunks", async () => {
  const response = await buildServer({ commandCodeClient: fakeClient([
    { type: "text-delta", text: "TEST_OK" },
    { type: "finish", finishReason: "end_turn" },
  ]) }).inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: "Bearer request-key" },
    payload: { model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "Hi" }], stream: true },
  });

  expect(response.headers["content-type"]).toContain("text/event-stream");
  expect(response.body).toContain("data: [DONE]");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- chat-completions.test.ts`

Expected: FAIL because the Fastify server and endpoint do not exist.

- [ ] **Step 3: Implement Chat Completions conversion and endpoint**

Create opaque response IDs using `crypto.randomUUID`. Map CommandCode text deltas into OpenAI delta chunks, map tool calls into `tool_calls`, map `end_turn` to `stop`, map tool-use termination to `tool_calls`, and map usage totals. Implement correct SSE headers and `data: [DONE]`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- chat-completions.test.ts`

Expected: PASS with non-streaming, streaming, usage-only chunk, tool call, and auth error tests.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/routes/chat-completions.ts src/translate/chat.ts test/chat-completions.test.ts
git commit -m "feat: add OpenAI chat completions endpoint"
```

### Task 5: Responses Endpoint, Models, Health, And Unsupported API Errors

**Files:**
- Create: `src/translate/responses.ts`
- Create: `src/routes/responses.ts`
- Create: `src/routes/models.ts`
- Create: `src/routes/health.ts`
- Create: `test/responses.test.ts`
- Create: `test/routes.test.ts`

**Interfaces:**
- Produces `toResponse(events, options): ResponseObject`.
- Produces `toResponseEvents(events, options): AsyncIterable<string>`.
- Adds `POST /v1/responses`, `GET /v1/models`, and `GET /healthz`.

- [ ] **Step 1: Write failing Responses and utility route tests**

```ts
it("returns a Responses API output item", async () => {
  const response = await buildServer({ commandCodeClient: fakeClient([
    { type: "text-delta", text: "TEST_OK" },
    { type: "finish", finishReason: "end_turn" },
  ]) }).inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer request-key" },
    payload: { model: "deepseek/deepseek-v4-flash", input: "Hi" },
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    object: "response",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "TEST_OK" }] }],
  });
});

it("lists configured proxy models and reports health", async () => {
  const app = buildServer({ commandCodeClient: fakeClient([]) });
  expect((await app.inject("/healthz")).json()).toEqual({ status: "ok" });
  expect((await app.inject("/v1/models")).json().object).toBe("list");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- responses.test.ts routes.test.ts`

Expected: FAIL because the Responses, models, and health routes do not exist.

- [ ] **Step 3: Implement Responses, models, health, and unsupported endpoint errors**

Implement response IDs, event lifecycle, `response.output_text.delta`, tool-call events, completion, and non-stream aggregation. Return known model IDs from `/v1/models` and expose a liveness-only `/healthz`. Register a catch-all `/v1/*` handler that returns `501` for unsupported OpenAI API groups.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- responses.test.ts routes.test.ts`

Expected: PASS with stream, non-stream, health, models, and unsupported-route tests.

- [ ] **Step 5: Commit**

```bash
git add src/routes src/translate/responses.ts test/responses.test.ts test/routes.test.ts
git commit -m "feat: add OpenAI responses and utility endpoints"
```

### Task 6: Documentation, Build Validation, And Live Smoke Test

**Files:**
- Create: `README.md`
- Modify: `.env.example`
- Modify: `package.json`
- Create: `test/security.test.ts`

**Interfaces:**
- Documents startup, key passthrough, supported endpoints, request examples, and unsupported behavior.

- [ ] **Step 1: Write failing security and documentation-facing tests**

```ts
it("redacts authorization values from log bindings", () => {
  expect(redactHeaders({
    authorization: "Bearer secret-value",
    "x-commandcode-api-key": "secret-value",
  })).toEqual({
    authorization: "[REDACTED]",
    "x-commandcode-api-key": "[REDACTED]",
  });
});
```

- [ ] **Step 2: Run the test to verify it fails or exposes missing coverage**

Run: `npm test -- security.test.ts`

Expected: FAIL until the redaction behavior is complete and tested.

- [ ] **Step 3: Add operational documentation and scripts**

Document `npm install`, `npm run dev`, `npm run build`, `npm start`, and a curl example that reads `COMMAND_CODE_API_KEY` from the environment. Document that the incoming bearer key is passed to CommandCode for the request only and must not be shared in logs. Add `typecheck` and `test` scripts.

- [ ] **Step 4: Run the complete verification suite**

Run: `npm test && npm run typecheck && npm run build`

Expected: all tests pass, TypeScript reports no errors, and the production build completes.

- [ ] **Step 5: Run a live smoke test**

Run the service with a valid `COMMAND_CODE_API_KEY` supplied only in the command environment, issue a single `/v1/chat/completions` request, verify `TEST_OK`, then stop the process. Do not store the key in a file, test fixture, or shell history.

- [ ] **Step 6: Commit**

```bash
git add README.md .env.example package.json test/security.test.ts
git commit -m "docs: document proxy operation"
```
