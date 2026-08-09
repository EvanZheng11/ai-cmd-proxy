# 与 9Router 集成（实战经验）

> 本文档记录 CommandCode Proxy v2 接入 9Router（decolua/9router）的真实部署经验与坑。
> 场景：TKO 服务器（HK）上 9router 0.5.50 + ccproxy（本仓库）同机部署，9router 的
> commandcode 板块模型统一走 ccproxy 出站。

## 为什么让 9router 走 ccproxy

9router 内置的 `commandcode` provider 直连官方 `/alpha/generate` 端点（原生协议），实测：

| 路径 | TTFT（简单请求） | 说明 |
|:--|:--|:--|
| 9router 内置 provider 直连 | ~2.0s | 原生协议转换 + 端点处理开销 |
| 9router → ccproxy（本代理） | ~1.1s | 纯 OpenAI 透传，Go 连接管理 |

走 ccproxy 首 token 快约一倍。**注意**：官方 `/alpha/generate` 已被禁止代理，
ccproxy v2 使用官方 `/provider/v1` OpenAI 兼容端点，这也是更快的原因之一。

## 9router 侧配置

### 1. 新增 openai-compatible 节点

```
类型: openai-compatible
名称: CommandCode Proxy
prefix: ccp          # 不能是 cc！cc 被 9router 内置 claude(Claude Code) provider 占用
baseUrl: http://172.18.0.1:55990/v1   # 9router 容器内经 docker 网关访问宿主机 ccproxy
```

### 2. 新增连接

```
provider: openai-compatible-chat-<节点id>
apiKey: 任意值（ccproxy 不校验客户端 Key）
```

### 3. 模型注册（关键！）

9router 对 openai-compatible 节点的模型路由规则：

- **动态拉取**（ccproxy `/v1/models`）的模型**只显示、不可路由**（请求会
  `404 model_not_found / No active credentials for provider: openai`）
- **combo 路由只认 kv 表手动注册的模型**，且模型名必须是**完整 ID**（含 `/`，
  如 `deepseek/deepseek-v4-flash`）；短名（`deepseek-v4-flash`）注册后直连可用、
  但 combo 依然 404

因此：**手动向 kv 注册完整 ID 模型**，格式（scope=`customModels`）：

```json
key:   "ccp|deepseek/deepseek-v4-flash|llm"
value: {"providerAlias":"ccp","id":"deepseek/deepseek-v4-flash","type":"llm","name":"DeepSeek V4 Flash"}
```

### 4. combo 引用

combo 表里 commandcode 板块的候选模型用完整 ID 前缀：

```json
"models": ["jy/deepseek-v4-flash-0731", "ccp/deepseek/deepseek-v4-flash"]
```

### 5. 停用内置直连

内置 `commandcode` provider 的连接（provider=`commandcode`）置 `isActive=0`，
防止双路径混用。

## 缓存行为（实测）

- **长对话（20 万+ token 上下文）**：命中率 99%+，缓存字段
  `prompt_tokens_details.cached_tokens` 正常透传到 new-api
- **整体命中率**：约 94%（30 分钟 / 3380 万输入 tokens / 3185 万命中）
- **短请求（2K token）**：基本不命中（cached_tokens=0），属正常——短前缀达不到
  DeepSeek 缓存生效门槛，且本身 prefill 快，无需处理
- 偶发超大上下文（33 万 tokens）缓存全失效（3%）：上游缓存淘汰导致，TTFT 会
  飙到 7~10s，属偶发

## 已知问题与坑

1. **模型列表重复**：ccproxy `/v1/models` 返回短名（`deepseek-v4-flash`），
   9router 动态拉取显示短名；手动注册的是完整 ID（`deepseek/deepseek-v4-flash`）。
   两者同时显示在列表。**根治需让 ccproxy `/v1/models` 返回完整 ID**
   （models.json 里本来就是完整 ID，接口返回时做了短名化），9router 动态与手动
   同 ID 合并即不重复。当前接受现状（能用即可）。
2. **9router 前缀冲突**：`cc` → 内置 claude provider；`cmc` → 内置 commandcode
   provider；`tr` → 内置 tokenrouter provider。自定义节点避开这几个前缀。
3. **改 ccproxy config.json 必须先 stop**：ccproxy 退出时会保存状态并重写
   config.json（覆盖手工修改）。流程：`systemctl stop ccproxy` → 改配置 → `start`。
4. **ccproxy 不校验客户端 Key**：任意 `Authorization: Bearer xxx` 都放行，
   公网暴露时需用防火墙/反代保护 55990。
5. **9router 容器重建丢 chunk 补丁**：若 9router 打了 chunk 热补丁（如
   8499.js 缓存透传），容器重建后需重新应用。
