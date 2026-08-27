# AI CommandCode Proxy

An OpenAI-compatible HTTP proxy for CommandCode.

## Run

```bash
npm install
npm run dev
```

The default listener is `127.0.0.1:3000`.

## Authentication

Pass the CommandCode API key per request using the normal OpenAI header:

```http
Authorization: Bearer <CommandCode API key>
```

The proxy forwards the credential only for the active upstream request. It does not persist or log the key.

## Chat Completions

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer ${COMMAND_CODE_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Reply with TEST_OK"}]
  }'
```

Set `"stream": true` for Server-Sent Events. The proxy also accepts `X-CommandCode-API-Key` for clients that cannot set `Authorization`.

## Responses

Use `POST /v1/responses` with `model`, `input`, optional `instructions`, `tools`, `reasoning`, and `stream`.

## Endpoints

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`

Unsupported OpenAI API groups return an OpenAI-shaped `501` response.

## Configuration

Copy `.env.example` into the process environment as needed:

```text
HOST=127.0.0.1
PORT=3000
COMMAND_CODE_API_URL=https://api.commandcode.ai
COMMAND_CODE_VERSION=1.36.0
DEFAULT_MAX_TOKENS=1000000
REQUEST_TIMEOUT_MS=600000
MAX_REQUEST_BYTES=20971520
```
