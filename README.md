# CommandCode Proxy

OpenAI 兼容代理，将 CommandCode API 转成本地 HTTP 服务，支持 Go 套餐下所有开源模型。

> 基于 [dev2k6/command-code-proxy-server](https://github.com/dev2k6/command-code-proxy-server) v1.0.8 修改，增加了中文推理支持、调试模式、Windows 管理脚本。

## 特性

- OpenAI 兼容端点：`/v1/chat/completions`、`/v1/models`
- 流式与非流式响应
- 模型推理过程透传（`reasoning_content`），支持中文思考
- 服务端 API Key 优先于客户端请求，客户端可随意填写 Key
- 22 个 Go 套餐模型，名称无厂商前缀
- 调试模式（`-debug`）打印完整事件流和用量明细
- Windows 管理脚本 + 开机自启

## 快速开始

```bash
# 编译
go build -o bin/command-code-proxy

# 运行（设置你的 API Key）
./bin/command-code-proxy -api-key user_xxx...
```

默认地址：`http://127.0.0.1:55990`

### Windows 管理

```powershell
# 交互菜单
.\command-code-proxy.ps1

# 或直接命令
ccproxy config   # 设置 API Key
ccproxy start    # 启动代理
ccproxy status   # 查看状态
ccproxy logs     # 查看日志
```

## CLI 参数

| 参数 | 默认值 | 说明 |
|:--|:--|:--|
| `-host` | `127.0.0.1` | 绑定地址，`0.0.0.0` 开放局域网 |
| `-port` | `55990` | 监听端口 |
| `-api-key` | 空 | CommandCode API Key |
| `-debug` | `false` | 启用调试日志 |
| `-version` | `false` | 显示版本号 |

### API Key 优先级

1. 服务端配置 Key（`-api-key` 或 `proxy-config.json`）优先级最高
2. 客户端 `Authorization` 头（仅在服务端未配置时生效）
3. 均未设置时返回 `401`

客户端可以传任意 `Authorization: Bearer xxx`，代理会使用服务端配置的真实 Key。

## 可用模型（Go 套餐）

### DeepSeek
`deepseek-v4-pro`, `deepseek-v4-flash`

### Kimi (MoonshotAI)
`kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k2.6`, `kimi-k2.5`

### GLM (ZhipuAI)
`glm-5.2`, `glm-5.2-fast`, `glm-5.1`, `glm-5`

### MiniMax
`minimax-m3`, `minimax-m2.7`, `minimax-m2.5`

### MiMo (Xiaomi)
`mimo-v2.5-pro`, `mimo-v2.5`

### Qwen
`qwen-3.7-max`, `qwen-3.7-plus`, `qwen-3.6-max-preview`, `qwen-3.6-plus`

### StepFun
`step-3.7-flash`, `step-3.5-flash`

### NVIDIA
`nemotron-3-ultra`

## 客户端配置

```
API 地址: http://127.0.0.1:55990/v1
API Key:  任意值
模型:     上表中的一个（如 deepseek-v4-flash）
```

## 项目结构

```
├── main.go                      # 入口
├── internal/
│   ├── api/                     # API 类型定义
│   │   ├── openai.go            #   客户端 OpenAI 格式
│   │   └── commandcode.go       #   CommandCode 内部格式
│   ├── proxy/
│   │   ├── proxy.go             #   核心代理逻辑
│   │   ├── convert.go           #   消息格式转换
│   │   └── model.go             #   模型名映射
│   ├── server/
│   │   └── server.go            #   HTTP 服务器
│   └── update/
│       └── update.go            #   版本检查
├── command-code-proxy.ps1       # Windows 管理脚本
├── ccproxy-autostart.ps1        # 开机自启脚本
├── ccproxy-profile.ps1          # PowerShell Profile 加载器
└── SKILL.md                     # HanaAgent 管理技能
```

## 编译

```bash
go build -o bin/command-code-proxy .
```

## 工作原理

1. 客户端发送 OpenAI 格式请求到本地代理
2. 代理将消息和模型名转为 CommandCode 格式
3. 转发到 `https://api.commandcode.ai/alpha/generate`
4. CommandCode 返回 NDJSON 事件流，代理转回 OpenAI 格式 SSE 或 JSON
5. 模型的推理过程（`reasoning-delta`）透传为 `reasoning_content` 字段
