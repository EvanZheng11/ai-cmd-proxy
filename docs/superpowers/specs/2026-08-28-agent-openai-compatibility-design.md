# Agent OpenAI Compatibility Design

## Goal

Make this service a strict, stateless OpenAI-compatible upstream for
`OpenCode`, `Codex CLI`, `Claude Code`, and similar agent clients when the
deployment path is:

```text
Agent -> sub2api -> ai-cmd-proxy -> CommandCode /alpha/generate
```

This work is limited to the existing authorized proxy implementation. It does
not reverse engineer hidden client behavior, use exposed credentials, bypass
plan restrictions, or call restricted provider endpoints.

## Compatibility Boundary

The supported OpenAI-compatible surface is the agent core:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /healthz`

Chat Completions and Responses support JSON and SSE streaming, text input,
base64 or public HTTP(S) image input, function tools, tool calls and results,
reasoning controls, structured-output instructions where representable,
usage, finish reasons, cancellation, timeout handling, and standard OpenAI
error bodies. Unsupported API groups return a stable `501` error instead of
claiming unsupported upstream capabilities.

The service remains stateless. `previous_response_id` is not resolved from
server-side storage; callers must include any history and tool results needed
for a follow-up request in the current input.

## Architecture and Data Flow

The HTTP routes validate OpenAI requests and extract the per-request
credential. Translation modules normalize Chat Completions and Responses
inputs into the existing CommandCode `/alpha/generate` request shape. The
upstream client creates request-scoped temporary state, sends the request,
parses newline-delimited JSON events, and removes temporary state on every
exit path. Response translators convert those events back to OpenAI JSON or
SSE.

Image URLs are materialized in the proxy before translation. Data URLs retain
their media type and base64 data. Public HTTP(S) URLs are fetched without
redirects, require an image content type, are protected against private DNS
targets, and are capped by the configured byte limit. Unsupported image
sources produce a clear `400` error rather than silently dropping the image.

## Streaming and Cancellation

For streaming routes, the implementation reads the first upstream event before
committing the downstream `200` status. After headers are committed, errors are
represented only using the relevant SSE error event; the server never attempts
to replace an already-started response with a JSON HTTP error.

Chat streaming emits an initial assistant-role chunk, text and tool-call
deltas, one finish chunk, optional usage when requested, and exactly one
`data: [DONE]` marker. Responses streaming emits a stable lifecycle beginning
with `response.created`, followed by output-item/content deltas and a
completion or error event.

The request timeout covers connection establishment, waiting for the first
byte, and subsequent upstream reads. It is configurable through
`REQUEST_TIMEOUT_MS`. A timeout maps to `504`; an upstream HTTP or protocol
failure maps to an appropriate OpenAI-compatible upstream error. Client
cancellation propagates to the upstream `AbortSignal`, stops downstream
writes, and still performs temporary-directory cleanup without being reported
as an upstream failure.

Empty bodies, malformed NDJSON, missing terminal events, and unexpected stream
termination are `502` protocol failures. Upstream `error` and `abort` events
are never converted into successful assistant output.

## Error and Logging Rules

Authentication failures use `401` and `authentication_error`; rate limits use
`429` and `rate_limit_error`; upstream failures use `api_error`; validation
failures use `invalid_request_error`. Every error includes the OpenAI-shaped
`error.message`, `error.type`, `error.param`, and `error.code` fields.

Credentials, request bodies containing user content, image base64 data, and
query parameters are excluded or sanitized from logs. Diagnostic logs may
include request IDs, model names, status, timing, and image metadata such as
media type and encoded length, but never image contents or credentials.

## Verification

Regression tests will cover:

- Chat and Responses text/image normalization, including data URLs and public
  image materialization.
- Developer/system messages, empty content, tool calls, tool results, and
  Responses history items.
- Chunked and slow NDJSON, first-byte delay, terminal events, incomplete
  streams, malformed events, and upstream errors.
- HTTP/1.1-compatible SSE headers, finish semantics, usage, and `[DONE]`.
- Request timeout, client cancellation, AbortSignal propagation, and cleanup.
- OpenAI-shaped validation, authentication, rate-limit, upstream, and
  unsupported-endpoint errors.
- Log redaction for authorization, query strings, request bodies, and image
  data.

The implementation is accepted only after these commands pass:

```bash
npm test
npm run typecheck
npm run build
```
