# CommandCode Proxy v2

OpenAI 兼容代理，将 **Command Code 官方 Provider API** 转为本地/公网 HTTP 服务。支持**多 Key 轮询**、**Web 管理面板**、**模型自动同步**。

> v2 基于官方 `/provider/v1` 端点重构（原 `/alpha/generate` 已被官方禁止代理，勿再用）。

## 特性

- 🚀 **OpenAI 兼容**：`/v1/chat/completions`、`/v1/responses`、`/v1/models`
- 🔑 **多 Key 轮询**：多个 Key 自动轮询调度，429 自动切换下一个 Key 重试
- ⏱ **智能冷却**：429/401 自动冷却，冷却后自动恢复
- 🛡 **自动禁用**：连续「冷却即错」或错误率过高自动禁用 Key（5h/period 限额），后台定时探测自动恢复
- 📦 **模型自动同步**：从官方 `/provider/v1/models` 自动拉取最新模型（含上下文窗口），支持短名→完整 ID 映射
- 🖥 **Web 管理面板**：动态增删 Key、一键健康检测、模型列表、设置项
- 💭 **思考过程保留**：`reasoning` 自动转换为 `reasoning_content`，兼容 CherryStudio 等客户端
- 🌐 **单二进制部署**：Go 编译，无外部依赖，systemd 一键托管

## 快速开始

```bash
# 编译
go build -o bin/command-code-proxy .

# 运行（首次自动写入 Key 池）
./bin/command-code-proxy -api-key user_xxx... -host 0.0.0.0 -port 55990
```

默认数据目录 `./data/`（config.json、keys.json、models.json）。

## 服务端部署（systemd）

```bash
# 交叉编译 Linux 版
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o bin/command-code-proxy-linux-amd64 .

# 上传到服务器后
install -m 0755 command-code-proxy-linux-amd64 /opt/ccproxy/command-code-proxy
cp scripts/ccproxy.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now ccproxy
```

或直接使用 `scripts/deploy.sh`。

## 管理面板

访问 `http://<服务器>:55990/`：

- **Key 管理**：添加/删除/启停 Key、一键健康检测、查看请求/错误统计
- **可用模型**：模型列表（厂商、上下文窗口、短名），手动触发同步
- **设置**：监听地址/端口、上游地址、冷却时间、同步间隔、调试日志、自动禁用开关

### 管理 API

| 端点 | 方法 | 说明 |
|:--|:--|:--|
| `/api/keys` | GET/POST | 列出/添加 Key |
| `/api/keys/{key}` | PUT/DELETE | 启停/删除 Key |
| `/api/health` | GET | 批量健康检测 |
| `/api/test-key` | POST | 单 Key 检测 |
| `/api/models` | GET | 模型列表+同步状态 |
| `/api/models/sync` | POST | 手动同步模型 |
| `/api/stats` | GET | 统计汇总 |
| `/api/config` | GET/PUT | 读取/修改配置 |

> 面板无鉴权，公网部署时请用防火墙/反代限制访问，或自行加一层认证。

## 客户端配置

```
API 地址: http://<服务器>:55990/v1
API Key:  任意值（代理使用 Key 池中的真实 Key）
模型:     面板模型列表中的短名（如 deepseek-v4-flash）或完整 ID（deepseek/deepseek-v4-flash）
```

短名会自动映射为完整 ID（Provider API 要求完整 ID）。

## CLI 参数

| 参数 | 默认值 | 说明 |
|:--|:--|:--|
| `-data-dir` | `./data` | 数据目录（config/keys/models） |
| `-host` | `0.0.0.0` | 监听地址 |
| `-port` | `55990` | 监听端口 |
| `-api-key` | 空 | 首次启动自动写入 Key 池（也可用 `CC_API_KEY` 环境变量） |
| `-debug` | `false` | 调试日志 |
| `-version` | `false` | 版本号 |

## 项目结构

```
├── main.go                      # 入口 + 后台任务（模型同步、Key 恢复扫描）
├── internal/
│   ├── api/openai.go            # OpenAI 类型定义
│   ├── config/config.go         # 配置加载/保存
│   ├── keypool/keypool.go       # 多 Key 池（轮询/冷却/自动禁用）
│   ├── models/                  # 模型注册表
│   │   ├── builtin.go           #   内置模型（兜底）
│   │   ├── models.go            #   存储/解析/状态
│   │   └── sync.go              #   官方 API 同步
│   ├── proxy/proxy.go           # 核心代理（透传 + 映射 + 429 切换）
│   └── server/                  # HTTP 服务
│       ├── server.go            #   路由 + 管理 API
│       └── panel.go             #   内嵌管理面板
└── scripts/
    ├── ccproxy.service          # systemd 服务
    └── deploy.sh                # 一键部署脚本
```

## 工作原理

1. 客户端发送 OpenAI 格式请求
2. 代理解析模型名：短名→完整 ID（如 `deepseek-v4-flash` → `deepseek/deepseek-v4-flash`）
3. 从 Key 池轮询取一个可用 Key，转发到 `https://api.commandcode.ai/provider/v1/chat/completions`
4. 上游 429 → 标记该 Key 冷却，自动用下一个 Key 重试一次
5. 响应透传（流式/非流式），`reasoning` 转 `reasoning_content`
6. 模型列表定时（默认 24h）从官方 `/provider/v1/models` 同步，面板可手动刷新
