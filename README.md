# AI CommandCode Proxy

An OpenAI-compatible HTTP proxy for CommandCode.
用于代理 CommandCode Go Plan，因为它不用使用官方开放出来的API接口，导致无法将它接入其他Agent，必须在CommandCode里使用。

## Run

```bash
npm install
npm run dev
```

The default listener is `127.0.0.1:3000`.

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

## Authentication

Pass the CommandCode API key per request using the normal OpenAI header:

```http
Authorization: Bearer <CommandCode API key>
```

The proxy forwards the credential only for the active upstream request. It does not persist or log the key. Remote image URLs are resolved only when they are public HTTP(S) resources, are not redirected, and are capped at 10 MiB.

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

## OpenCode Image Input

For OpenCode, declare the visual model as accepting image input. Otherwise OpenCode replaces the attachment with an error text before the request reaches this proxy:

```jsonc
{
  "provider": {
    "commandcode": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:3000/v1"
      },
      "models": {
        "deepseek/deepseek-v4-flash-vision-exp": {
          "name": "CommandCode DeepSeek Vision",
          "attachment": true,
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          }
        }
      }
    }
  }
}
```

Keep the model name as `deepseek/deepseek-v4-flash-vision-exp`. When an image is present, the proxy converts data URLs or public image URLs to CommandCode image blocks in the native `image`/`mediaType` format.

## Endpoints

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`

Unsupported OpenAI API groups return an OpenAI-shaped `501` response. OpenAI tool-selection controls that CommandCode cannot represent return `400` instead of being ignored.

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

## Prompt Pass-Through Behavior

The proxy does not append JSON or other natural-language instructions to prompts.
The adapter has no verified native structured-output support, so JSON
`response_format` and non-text Responses `text.format` requests return HTTP 400
instead of modifying the prompt. Explicit `type: "text"` remains supported.

System and developer text is collected in order into the upstream's single
system string with `\n\n` between messages (including empty messages) and `\n`
between text blocks. Original role boundaries and positions relative to other
messages cannot be represented by this protocol. Text whitespace is not trimmed.
Tool and image conversion remains unchanged, including downloading remote images
as base64. This is not a byte-for-byte relay and does not guarantee improved
cache hit rates; cache hits are determined by the upstream provider.

## Cache Stability

CommandCode prompt caching matches on the request prefix, and `config` is part
of the upstream payload. The proxy therefore keeps one fixed `workingDir` per
client instance (created on first request, reused afterwards) instead of a
random temp directory per request, so multi-turn conversations keep a stable
prefix and cached tokens can actually be reused.

Responses history items without a `role` — `function_call`,
`function_call_output`, and `reasoning` — are translated into the equivalent
assistant/tool messages instead of being dropped, so follow-up requests carry
the full conversation history the upstream needs to hit its cache.

## License

[MIT](./LICENSE)
