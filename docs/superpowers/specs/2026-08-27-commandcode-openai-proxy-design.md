# CommandCode OpenAI Proxy Design

**Date:** 2026-08-27

## Goal

Build a stateless Node.js and TypeScript service in `/Users/andyzheng/git/ai-cmd-proxy` that accepts OpenAI-compatible requests from sub2api and translates them into CommandCode `/alpha/generate` requests, preserving streaming, multimodal messages, tools, reasoning controls, usage, and standard error behavior.

## Scope

The first implementation supports:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`
- `GET /healthz`
- Text messages and public image URLs or base64 data URLs
- Tool definitions, tool calls, and tool results
- Structured output requests where they can be represented by the CommandCode prompt contract
- `model`, `max_tokens`, `max_completion_tokens`, `reasoning_effort`, `temperature`, `top_p`, `stop`, `tool_choice`, `parallel_tool_calls`, and `stream_options.include_usage`
- OpenAI-compatible JSON responses and Server-Sent Events

The service does not claim to implement upstream capabilities that CommandCode cannot execute. Audio, embeddings, image generation, file management, batch jobs, and moderation return a standard OpenAI-shaped `501` or `400` error with a stable error code.

## Authentication

Each inbound request must provide a CommandCode credential using the OpenAI-compatible header:

```text
Authorization: Bearer <CommandCode API key>
```

The service also accepts `X-CommandCode-API-Key` for clients that cannot set an Authorization header. The header value is used only for the active upstream request. It is never persisted, included in request logs, returned in errors, or placed in a cache.

The proxy sends the upstream headers required by CommandCode 1.36.0:

```text
Content-Type: application/json
Authorization: Bearer <key>
User-Agent: cli
x-command-code-version: 1.36.0
x-cli-environment: production
x-taste-learning: true
x-session-id: <UUID>
```

## Architecture

The service is divided into focused modules:

- `src/server.ts`: Fastify application and lifecycle.
- `src/routes/chat-completions.ts`: Chat Completions request and response handling.
- `src/routes/responses.ts`: Responses API request and response handling.
- `src/routes/models.ts`: OpenAI model catalog response.
- `src/routes/health.ts`: liveness endpoint.
- `src/auth.ts`: request-scoped credential extraction and redacted logging helpers.
- `src/commandcode/client.ts`: upstream HTTP client, timeout, headers, and response stream handling.
- `src/commandcode/types.ts`: CommandCode wire types.
- `src/translate/messages.ts`: OpenAI message/input to CommandCode wire message conversion.
- `src/translate/tools.ts`: tool schema and tool result conversion.
- `src/translate/chat.ts`: Chat Completions response conversion.
- `src/translate/responses.ts`: Responses API event conversion.
- `src/errors.ts`: stable OpenAI-shaped errors and upstream error mapping.
- `src/config.ts`: environment configuration and defaults.

The proxy is stateless. It does not persist conversations, API keys, images, upstream response bodies, or tool results.

## Request Translation

### CommandCode configuration

Every `/alpha/generate` request includes the required configuration shape:

```json
{
  "workingDir": "/tmp/ai-cmd-proxy-a1b2c3",
  "date": "2026-08-27",
  "environment": "darwin",
  "structure": [],
  "isGitRepo": false,
  "currentBranch": "",
  "mainBranch": "",
  "gitStatus": "",
  "recentCommits": []
}
```

Before each upstream request, the proxy creates a unique temporary working directory using the operating system temporary directory and a random suffix, for example `/tmp/ai-cmd-proxy-a1b2c3`. The directory is empty unless the request contains data that must be staged locally. It is removed after the upstream stream finishes or fails. The date is generated at request time, and the environment value comes from the running process.

### Chat Completions

The adapter maps `messages` to `params.messages`, maps `model` to `params.model`, sets `stream` to `true` for the upstream request, and maps the supported generation controls into `params`.

The top-level CommandCode request has this shape:

```json
{
  "config": {},
  "memory": null,
  "taste": null,
  "skills": null,
  "permissionMode": "standard",
  "mode": "agent",
  "params": {
    "model": "deepseek/deepseek-v4-flash",
    "messages": [],
    "tools": [],
    "system": "",
    "max_tokens": 1000000,
    "stream": true
  }
}
```

`max_completion_tokens` takes precedence over `max_tokens`. If neither is supplied, the proxy uses `1_000_000`.

Text content is converted to CommandCode text blocks. Image URL and data URL content is converted to the CommandCode image block with its media type and base64 data. Unsupported image sources return a `400` error.

### Responses API

The adapter accepts `input` as a string, a message array, or content-part arrays. `instructions` becomes the CommandCode system prompt. Responses tools are converted to CommandCode tools. `previous_response_id` is rejected unless a future state store is enabled, because the proxy is stateless.

## Upstream Streaming

CommandCode `/alpha/generate` is consumed as newline-delimited JSON. The parser recognizes:

- `text-delta`
- `reasoning-start`
- `reasoning-delta`
- `reasoning-end`
- `tool-call`
- `tool-result`
- `finish`
- `error`
- `abort`

The adapter accumulates enough state to produce correct OpenAI IDs, timestamps, finish reasons, tool call indexes, and usage values. It forwards text and reasoning incrementally and closes the SSE stream after `finish`, `error`, or `abort`.

Chat Completions streaming emits `chat.completion.chunk` events and optionally a final usage-only chunk when `stream_options.include_usage` is true.

Responses streaming emits the standard lifecycle events required by the Responses API, including response creation, output item creation, text deltas, tool-call deltas where applicable, and response completion.

## Tool Calls

OpenAI function tools are converted to CommandCode tool schemas:

```json
{
  "name": "get_weather",
  "description": "Get weather",
  "input_schema": {
    "type": "object",
    "properties": {
      "city": {
        "type": "string"
      }
    },
    "required": ["city"]
  }
}
```

CommandCode `tool-call` events become OpenAI tool calls. Tool results from a follow-up request become CommandCode `tool-result` blocks. Tool calls are never executed by the proxy itself.

## Structured Output

`response_format` with `json_object` or `json_schema` is translated into an explicit system constraint and retained in the response metadata. The adapter validates JSON object output when possible and returns a standard `422` error when the upstream output cannot satisfy the requested JSON form.

## Errors and Limits

The proxy maps errors as follows:

- Missing or malformed credential: `401`
- Invalid OpenAI request: `400`
- Unsupported capability: `501`
- CommandCode authentication failure: `401`
- CommandCode rate limit: `429`
- Upstream timeout: `504`
- Upstream connection or stream failure: `502`

Error responses use:

```json
{
  "error": {
    "message": "Human-readable message",
    "type": "invalid_request_error",
    "param": null,
    "code": "proxy_error_code"
  }
}
```

Request bodies, image contents, authorization values, and upstream response bodies are excluded from logs. The proxy applies request, connection, and response size limits from environment configuration.

## Configuration

```text
HOST=127.0.0.1
PORT=3000
COMMAND_CODE_API_URL=https://api.commandcode.ai
COMMAND_CODE_VERSION=1.36.0
DEFAULT_MAX_TOKENS=1000000
REQUEST_TIMEOUT_MS=600000
MAX_REQUEST_BYTES=20971520
```

## Testing

Tests are written before implementation and cover:

- Chat Completions non-streaming and streaming responses
- Responses non-streaming and streaming responses
- Text and image content conversion
- Tool definitions, calls, and results
- `response_format` and JSON Schema handling
- Model, token, reasoning, sampling, stop, and usage options
- Authentication extraction and credential redaction
- CommandCode request shape and required headers
- Upstream errors, timeout, malformed events, and stream interruption
- Models and health endpoints
- Unsupported endpoint behavior

Integration tests use a local fake CommandCode transport and never include a real API key.
