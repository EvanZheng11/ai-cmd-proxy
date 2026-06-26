---
name: ccproxy
---

# ccproxy 管理技能

CommandCode Proxy 的本地管理工具。将 CommandCode CLI 转为 OpenAI 兼容 API，支持 Go 套餐下所有开源模型。

> **前置条件**：CommandCode 账户（已订阅 Go 套餐） + API Key

---

## 快速开始

```powershell
ccproxy           # 交互菜单
ccproxy config    # 设置 API Key
ccproxy start     # 启动代理
```

> 首次使用先执行 `ccproxy config` 填入 API Key。

---

## 目录结构

```
_tools/command-code-proxy/
├── bin/
│   └── command-code-proxy.exe    # 编译好的二进制文件
├── logs/                         # 日志目录
│   ├── YYYY-MM-DD.log            # 代理标准输出
│   ├── YYYY-MM-DD-err.log        # 代理错误输出
│   └── mgmt-YYYY-MM-DD.log       # 管理操作日志
├── proxy.pid                     # 进程 PID 文件
├── proxy-config.json             # 配置文件
├── ccproxy-autostart.ps1         # 开机自启脚本
├── ccproxy-profile.ps1           # PowerShell Profile 载入脚本
└── command-code-proxy.ps1        # 主管理脚本
```

---

## 管理命令

通过全局 `ccproxy` 命令调用：

| 命令 | 说明 |
|:--|:--|
| `ccproxy` | 交互式菜单（中文界面） |
| `ccproxy status` | 查看运行状态、PID、内存、健康检查 |
| `ccproxy start` | 启动代理 |
| `ccproxy stop` | 停止代理 |
| `ccproxy restart` | 重启代理 |
| `ccproxy config` | 修改 API Key、端口、绑定地址 |
| `ccproxy logs` | 查看代理输出 + 管理日志 |
| `cd ccp` | 快速跳转到 ccproxy 目录 |

---

## 配置文件

`proxy-config.json` 自动生成，内容示例：

```json
{"port":55990,"host":"127.0.0.1","apiKey":"user_xxxxxxxx..."}
```

- **host**：绑定地址，`127.0.0.1` 仅本地，`0.0.0.0` 允许局域网访问
- **port**：监听端口，默认 55990
- **apiKey**：CommandCode API Key

修改后需重启代理生效。

---

## Go 套餐可用模型

> 来自 CommandCode 官方文档。仅包含 Go 计划可用的开源模型。

### DeepSeek

| 模型名 | 说明 |
|:--|:--|
| `deepseek-v4-pro` | 混合注意力长上下文推理 |
| `deepseek-v4-flash` | 快速混合注意力推理（默认） |

### Kimi（MoonshotAI）

| 模型名 | 说明 |
|:--|:--|
| `kimi-k2.7-code` | 增强版长程编码（带视觉） |
| `kimi-k2.7-code-highspeed` | 高速版长程编码（带视觉） |
| `kimi-k2.6` | 长程编码（带视觉） |
| `kimi-k2.5` | 多模态前端编码 |

### GLM（ZhipuAI）

| 模型名 | 说明 |
|:--|:--|
| `glm-5.2` | 1M 上下文长程任务 |
| `glm-5.2-fast` | GLM-5.2 高吞吐版 |
| `glm-5.1` | 长程自主编码代理 |
| `glm-5` | 多模态思考与长期规划 |

### MiniMax

| 模型名 | 说明 |
|:--|:--|
| `minimax-m3` | 前沿编码与原生多模态 |
| `minimax-m2.7` | 端到端软件工程代理 |
| `minimax-m2.5` | 跨平台全栈开发 |

### MiMo（Xiaomi）

| 模型名 | 说明 |
|:--|:--|
| `mimo-v2.5-pro` | 高性能长上下文代理编码 |
| `mimo-v2.5` | 高效长上下文代理编码（带视觉） |

### Qwen

| 模型名 | 说明 |
|:--|:--|
| `qwen-3.7-max` | 前沿编码与长程代理 |
| `qwen-3.7-plus` | 低成本代理编码与推理 |
| `qwen-3.6-max-preview` | 氛围编码与高效代理 |
| `qwen-3.6-plus` | 代理编码与推理（带视觉） |

### StepFun

| 模型名 | 说明 |
|:--|:--|
| `step-3.7-flash` | 多模态稀疏 MoE 推理 |
| `step-3.5-flash` | 快速稀疏 MoE 代理推理 |

### NVIDIA

| 模型名 | 说明 |
|:--|:--|
| `nemotron-3-ultra` | 开源推理模型（长程自主代理） |

---

## 客户端配置

任何 OpenAI 兼容客户端均可使用：

```
API 地址: http://127.0.0.1:55990/v1
API Key:  任意值（proxy 使用配置文件的真实 Key）
模型:     上方列表中的模型名（如 deepseek-v4-flash）
```

> API Key 字段随意填写即可，proxy 内部会使用配置文件中的真实 Key 去调用 CommandCode。

---

## 开机自启

已在启动文件夹 `shell:startup` 创建快捷方式，下次登录时自动启动。

如需移除：

```powershell
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\CCProxy-Autostart.lnk"
```

---

## 常见问题

### 代理启动失败

1. 检查 `proxy-config.json` 中 API Key 是否已设置
2. 检查端口 55990 是否被占用：`netstat -ano | findstr :55990`
3. 查看日志：`ccproxy logs`

### 401 未经授权

CommandCode API Key 无效或已过期。重新执行 `ccproxy config` 更新。

### 模型列表不更新

客户端可能缓存了模型列表，在客户端设置中刷新或重启客户端。

### 无法停止进程

如果 `ccproxy stop` 失败，手动终止：

```powershell
Get-Process command-code-proxy | Stop-Process -Force
```

### 更新版本

```powershell
cd ccp
git pull
go build -o bin/command-code-proxy.exe .
ccproxy restart
```

---

## 技术细节

- 二进制路径：`_tools\command-code-proxy\bin\command-code-proxy.exe`
- 默认端点：`http://127.0.0.1:55990/v1/chat/completions`
- 超时时间：300 秒
- 编译环境：Go 1.26.4
- 项目源码：`dev2k6/command-code-proxy-server` v1.0.8
