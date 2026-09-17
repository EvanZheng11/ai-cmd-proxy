# CommandCode 稳定性修复验证记录

验证日期：2026-09-18；服务地址：本机 127.0.0.1:3000。

## 自动验证

- `npm test -- --silent --reporter=dot`：11 个文件、220 项测试通过。
- `npm run typecheck`、`npm run build`、`git diff --check`：通过。
- 覆盖完整工具输出与多轮历史、推理、namespace 映射、HTTP/SSE 错误、取消传播、有限重试、日志脱敏。
- 独立审查发现的转义引号脱敏及空增量预读问题已补测试并修复，复核通过。

## 重启后的真实服务测试

在备份旧构建后部署新 dist，使用原 Node 可执行文件和进程环境重启。PID 文件改为实际 Node 进程 ID，核对监听端口和健康状态。

| 测试 | 结果 |
| --- | --- |
| `/healthz` | HTTP 200 |
| 无凭证请求 | HTTP 401 |
| 不支持的 `web_search` 工具 | HTTP 400，`param=tools[0].type` |
| 真实 Chat 文本请求 | HTTP 200，返回指定标记，约 5.8 秒 |
| 真实 Responses 流式 namespace 工具调用 | HTTP 200，约 3.0 秒；增量与最终 output 的调用 ID 和名称一致，无空 assistant |
| 回传工具结果及上一轮全部 output | HTTP 200，约 2.5 秒；返回工具提供的标记 |

生成测试使用 `deepseek/deepseek-v4.1-flash`，凭证仅从本机现有配置读取，不进入报告、代码或提交。

## 能力边界

托管 web_search/image_generation、custom、嵌套 namespace 和 encrypted_content 不在当前适配范围内。短时真实请求测试不代表上游未来没有容量、网络或网关错误；新日志可以保留其错误阶段和原因，且已输出内容的流不会自动重放。远程图片下载仍使用原有独立超时，生成阶段支持客户端取消。
