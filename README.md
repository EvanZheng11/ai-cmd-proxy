# AI CommandCode Proxy

An OpenAI-compatible HTTP proxy for CommandCode.
用于代理 CommandCode Go Plan，因为它不能使用官方开放出来的API接口，导致无法将它接入其他Agent，必须在CommandCode里使用。但它$1可以使用$10的额度，挺划算的，多注册几个号代理到中转站自动切换还是不错的。

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
DEFAULT_MAX_TOKENS=32000
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

## 稳定性与兼容范围

代理对尚未输出任何上游事件的瞬时连接异常和 HTTP 502/503/504 最多尝试三次，使用退避和同一个 `REQUEST_TIMEOUT_MS` 总预算。400/401/403、未知异常、主动取消及已经开始的流不会自动重放。上游容量错误仍可能需要 sub2api 切换可用渠道。

响应头的 `x-request-id` 与代理日志的 `requestId` 对应。失败日志包含 `attempt`、`stage`、`eventsReceived`、`durationMs`、`errorMessage`、`causeCode`，不再记录完整请求和响应正文。首个有效输出之前的错误返回真实 HTTP 状态；Responses 流中错误以同一响应 ID 的 `response.failed` 结束，并携带 `error.status_code`。客户端断开会取消上游生成。

Responses 的最终 `output` 保留全部工具调用及其顺序、ID，不再为纯工具调用追加空 assistant 消息。工具结果前的同轮 assistant 条目会合并，推理文本以原生 reasoning 块传回上游；Chat Completions 支持 `reasoning_content`。加密推理内容不在支持范围内。

支持普通 function 工具和 namespace 内的 function 工具；namespace 名称在上游展开，返回时还原，后续请求需携带对应工具定义。`web_search`、`image_generation`、custom 及嵌套 namespace 没有对应执行能力，返回带具体 `param` 的 400；应在客户端为该渠道改用普通 function 工具。不会静默删除工具或伪造工具结果。

本项目的 TypeScript Go Plan 代理默认监听 3000，`start.sh` 启动 `dist/index.js`。部署时应核对监听 PID；旧版 Go provider 服务可能使用其他端口及同名 systemd 服务，不能用其重启结果代替本服务验证。

## License

[MIT](./LICENSE)
