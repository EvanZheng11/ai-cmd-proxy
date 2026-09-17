# CommandCode 稳定性实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 修复已复现的协议错误并让瞬时网络失败可诊断、有限恢复，重启验证后提交推送。

**Architecture:** 保留 Fastify 路由、CommandCode client、转换器分层。转换器负责历史完整性；路由负责 HTTP/SSE 生命周期；client 负责总超时、有限重试及连接诊断。

**Tech Stack:** TypeScript、Node fetch、Fastify、Zod、Vitest。

## 1. Responses 与工具历史

- [ ] 在 `test/responses.test.ts` 或独立回归文件覆盖纯工具最终 output、空消息隔断、文本和工具顺序、system/developer、reasoning、namespace 往返及不支持工具报错。
- [ ] 运行 `npm test -- --silent`，确认新增断言失败。
- [ ] 修改 `src/translate/responses.ts`、`messages.ts`、`chat.ts`、`src/openai/{types,schemas}.ts`、`src/commandcode/types.ts`，保持原接口兼容。
- [ ] 运行对应测试和 `npm run typecheck`。

## 2. 网络恢复与诊断

- [ ] 在 `test/commandcode-client.test.ts` 或独立回归文件覆盖连接重置后成功、重试耗尽、HTTP 400不重试、已有流不重试、总超时、取消退避、敏感信息脱敏。
- [ ] 先运行失败用例，再修改 `src/commandcode/client.ts`：最多三次、可取消退避、受同一超时约束、保留cause和阶段。
- [ ] 运行客户端相关测试。

## 3. 路由生命周期

- [ ] 增加首事件400/429、start后失败、流中失败终止、真实HTTP客户端断开测试。
- [ ] 修改 `src/routes/{responses,chat-completions}.ts` 与 `src/errors.ts`，在提交响应前检查事件，输出标准终止错误，传递取消信号。
- [ ] 日志按requestId关联，并明确本地校验错误字段；记录兼容性限制到README。
- [ ] 运行 `npm test -- --silent`、`npm run typecheck`、`npm run build` 并审查diff。

## 4. 部署和交付

- [ ] 检查运行进程、PID文件、启动环境；备份现有dist及运行信息。
- [ ] 部署已验证构建并重启实际3000服务，检查健康、缺少凭证及unsupported工具响应。
- [ ] 使用本机现有凭证完成短文本、流式及工具多轮请求，凭证不得输出或提交。
- [ ] 服务测试通过后，检查status/diff/log，仅提交本次文件；合并main并推送github/main。
- [ ] worktree切到detached后删除临时分支，保留目录；报告commit和测试结果。
