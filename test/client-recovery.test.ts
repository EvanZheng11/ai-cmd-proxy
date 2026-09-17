import { afterEach, describe, expect, it, vi } from "vitest";

import { createCommandCodeClient } from "../src/commandcode/client.js";
import type { CommandCodeGenerateInput } from "../src/commandcode/types.js";
import { loadConfig } from "../src/config.js";

const request: CommandCodeGenerateInput = {
  memory: null, taste: null, skills: null, permissionMode: "standard", mode: "agent",
  params: {
    model: "test-model", messages: [{ role: "user", content: [{ type: "text", text: "private prompt" }] }],
    tools: [], system: "", max_tokens: 1_000_000, stream: true,
  },
};
const input = { apiKey: "current-secret", request, requestId: "request-1" };
const finish = () => new Response('{"type":"finish"}\n');
const networkError = (code = "ECONNRESET", message = "socket closed") =>
  new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}
function setup(overrides: Partial<Parameters<typeof createCommandCodeClient>[0]> = {}) {
  const logger = vi.fn();
  const delay = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
  const client = createCommandCodeClient({
    config: loadConfig({ REQUEST_TIMEOUT_MS: "1000" }),
    createTempDir: async () => "/tmp/stable-client-recovery",
    createSessionId: () => "session-1", logger, delay, random: () => 0.5,
    ...overrides,
  });
  return { client, logger, delay };
}
afterEach(() => vi.useRealTimers());

describe("CommandCode 网络恢复", () => {
  it.each(["ECONNRESET", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_SOCKET", "CONNECT_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"])("在 %s 后恢复并保持请求前缀和总 signal", async (code) => {
    const fetch = vi.fn().mockRejectedValueOnce(networkError(code)).mockResolvedValueOnce(finish());
    const { client, delay } = setup({ fetch });
    await expect(collect(client.stream(input))).resolves.toEqual([{ type: "finish" }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]).toEqual(fetch.mock.calls[1][1]);
    expect(JSON.parse(fetch.mock.calls[1][1].body).params.max_tokens).toBe(200_000);
  });

  it("最多三次并保留最后原始 cause，指数退避包含小抖动", async () => {
    const original = networkError();
    const fetch = vi.fn().mockRejectedValue(original);
    const { client, delay } = setup({ fetch });
    await expect(collect(client.stream(input))).rejects.toMatchObject({ status: 502, cause: original });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(delay.mock.calls.map((call) => call[0])).toEqual([125, 225]);
  });

  it.each([502, 503, 504])("HTTP %s 取消失败 body 后恢复", async (status) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetch = vi.fn().mockResolvedValueOnce(new Response(body, { status })).mockResolvedValueOnce(finish());
    const { client } = setup({ fetch });
    await expect(collect(client.stream(input))).resolves.toEqual([{ type: "finish" }]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it.each([400, 401, 403, 500, 501])("HTTP %s 不重试且不记录敏感 body", async (status) => {
    const body = '{"error":{"message":"private upstream body"}}';
    const fetch = vi.fn().mockResolvedValue(new Response(body, { status }));
    const { client, logger, delay } = setup({ fetch });
    await expect(collect(client.stream(input))).rejects.toMatchObject({ status, body });
    expect(fetch).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/private upstream body|private prompt/);
  });

  it.each([new TypeError("unknown"), new DOMException("cancelled", "AbortError"), new DOMException("expired", "TimeoutError")])("不重试未知错误或取消/超时：%s", async (error) => {
    const fetch = vi.fn().mockRejectedValue(error);
    const { client } = setup({ fetch });
    await expect(collect(client.stream(input))).rejects.toMatchObject({ cause: error });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("读流在首事件前断开可以恢复", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(networkError()); } });
    const fetch = vi.fn().mockResolvedValueOnce(new Response(body)).mockResolvedValueOnce(finish());
    const { client } = setup({ fetch });
    await expect(collect(client.stream(input))).resolves.toEqual([{ type: "finish" }]);
    expect(body.locked).toBe(false);
  });

  it("任何事件已经 yield 后读流失败不可重放", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      streamController = controller;
      controller.enqueue(new TextEncoder().encode('{"type":"start"}\n'));
    } });
    const fetch = vi.fn().mockResolvedValue(new Response(body));
    const { client, logger } = setup({ fetch });
    const iterator = client.stream(input)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "start" } });
    const original = networkError();
    streamController.error(original);
    await expect(iterator.next()).rejects.toMatchObject({ cause: original });
    expect(fetch).toHaveBeenCalledOnce();
    expect(logger).toHaveBeenCalledWith("CommandCode 请求失败", expect.objectContaining({
      stage: "read", eventsReceived: 1, causeCode: "ECONNRESET",
    }));
    expect(body.locked).toBe(false);
  });

  it("NDJSON 业务错误原样交给路由，不重试", async () => {
    const event = { type: "error", error: "private business body", statusCode: 503, isRetryable: true };
    const fetch = vi.fn().mockResolvedValue(new Response(`${JSON.stringify(event)}\n`));
    const { client, logger } = setup({ fetch });
    await expect(collect(client.stream(input))).resolves.toEqual([event]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.mock.calls)).not.toContain("private business body");
  });

  it("取消会立刻打断默认退避并清理外部监听器", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const fetch = vi.fn().mockRejectedValue(networkError());
    const { client, logger } = setup({ fetch, delay: undefined });
    const reason = new Error("caller cancelled");
    const result = collect(client.stream({ ...input, signal: controller.signal }));
    const assertion = expect(result).rejects.toMatchObject({ cause: reason });
    await vi.advanceTimersByTimeAsync(0);
    expect(logger).toHaveBeenCalledWith("CommandCode 请求重试", expect.anything());
    controller.abort(reason);
    await assertion;
    expect(fetch).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("重试和退避共享同一总预算", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockRejectedValue(networkError());
    const { client } = setup({ fetch, delay: undefined, config: loadConfig({ REQUEST_TIMEOUT_MS: "200" }) });
    const result = collect(client.stream(input));
    const assertion = expect(result).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("总预算打断卡住的 read 并取消 body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetch = vi.fn().mockResolvedValue(new Response(body));
    const { client } = setup({ fetch, config: loadConfig({ REQUEST_TIMEOUT_MS: "50" }) });
    const result = collect(client.stream(input));
    const assertion = expect(result).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("已经取消不发起 fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn().mockResolvedValue(finish());
    const { client } = setup({ fetch });
    await expect(collect(client.stream({ ...input, signal: controller.signal }))).rejects.toMatchObject({ cause: controller.signal.reason });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("诊断包含关联字段与原始 cause 消息且所有日志脱敏", async () => {
    const original = networkError("ECONNRESET", 'socket Bearer bearer-secret apiKey=key-secret password="password secret" current-secret');
    const fetch = vi.fn().mockRejectedValue(original);
    const { client, logger } = setup({ fetch });
    await expect(collect(client.stream(input))).rejects.toMatchObject({ cause: original });
    expect(logger).toHaveBeenCalledWith("CommandCode 请求失败", expect.objectContaining({
      sessionId: "session-1", requestId: "request-1", attempt: 3, stage: "fetch", eventsReceived: 0,
      durationMs: expect.any(Number), errorMessage: expect.stringContaining("socket"), causeCode: "ECONNRESET",
    }));
    const logs = JSON.stringify(logger.mock.calls);
    expect(logs).not.toMatch(/bearer-secret|key-secret|password secret|current-secret|private prompt/);
    expect(logs).toContain("[REDACTED]");
  });

  it.each([
    ["JSON 双引号转义", JSON.stringify({ password: 'prefix"provider-password-suffix', apiKey: 'prefix"provider-key-suffix' })],
    ["单引号转义", String.raw`password='prefix\'provider-password-suffix' apiKey='prefix\'provider-key-suffix'`],
    ["JSON 反斜杠与双引号转义", JSON.stringify({ password: 'prefix\\"provider-password-suffix', apiKey: 'prefix\\"provider-key-suffix' })],
    ["反斜杠与单引号转义", String.raw`password='prefix\\\'provider-password-suffix' apiKey='prefix\\\'provider-key-suffix'`],
    ["JSON 值末尾反斜杠", JSON.stringify({ password: "provider-password-suffix\\", apiKey: "provider-key-suffix\\" })],
    ["单引号值末尾反斜杠", String.raw`password='provider-password-suffix\\' apiKey='provider-key-suffix\\'`],
  ])("真实 client 日志完整脱敏：%s", async (_description, message) => {
    const original = networkError("ECONNRESET", `${message} diagnostic-tail`);
    const fetch = vi.fn().mockRejectedValue(original);
    const { client, logger } = setup({ fetch });
    await expect(collect(client.stream(input))).rejects.toMatchObject({ cause: original });

    const diagnostics = logger.mock.calls.filter(([message]) =>
      message === "CommandCode 请求重试" || message === "CommandCode 请求失败");
    expect(diagnostics).toHaveLength(3);
    for (const [, context] of diagnostics) {
      expect(context).toMatchObject({
        causeCode: "ECONNRESET", errorMessage: expect.stringContaining("diagnostic-tail"),
      });
      expect(context.errorMessage).toContain("[REDACTED]");
    }
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/provider-password-suffix|provider-key-suffix/);
    expect((original.cause as Error).message).toBe(`${message} diagnostic-tail`);
  });

  it.each([
    'prefix"actual-api-key-suffix',
    "prefix'actual-api-key-suffix",
    "prefix\\actual-api-key-suffix",
    'prefix\\"actual-api-key-suffix',
    "prefix\\'actual-api-key-suffix",
  ])("真实 client 日志脱敏实际 API key 的原文及转义形式：%s", async (apiKey) => {
    const quotedKey = apiKey.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const message = `raw=${apiKey}; ${JSON.stringify({ detail: apiKey })}; detail='${quotedKey}' diagnostic-tail`;
    const original = networkError("ECONNRESET", message);
    const fetch = vi.fn().mockRejectedValue(original);
    const { client, logger } = setup({ fetch });
    await expect(collect(client.stream({ ...input, apiKey }))).rejects.toMatchObject({ cause: original });
    expect(logger).toHaveBeenCalledWith("CommandCode 请求失败", expect.objectContaining({
      causeCode: "ECONNRESET", errorMessage: expect.stringContaining("diagnostic-tail"),
    }));
    expect(JSON.stringify(logger.mock.calls)).not.toContain("actual-api-key-suffix");
    expect((original.cause as Error).message).toBe(message);
  });

  it("无效 NDJSON 的 SyntaxError 不泄露响应片段且保留 cause", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("bodysecret\n"));
    const { client, logger } = setup({ fetch });
    await expect(collect(client.stream(input))).rejects.toMatchObject({ status: 502, cause: expect.any(SyntaxError) });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.mock.calls)).not.toContain("bodysecret");
  });

  it("转义字符凭证脱敏不破坏日志或请求", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("line\nnext"));
    const { client, logger } = setup({ fetch });
    await expect(collect(client.stream({ ...input, apiKey: "n" }))).rejects.toMatchObject({ cause: expect.any(TypeError) });
    expect(logger).toHaveBeenCalledWith("CommandCode 请求失败", expect.anything());
  });

  it("HTTP400 的 body 读取网络失败也不可重试", async () => {
    const original = networkError();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(original); } });
    const fetch = vi.fn().mockResolvedValue(new Response(body, { status: 400 }));
    const { client } = setup({ fetch });
    await expect(collect(client.stream(input))).rejects.toMatchObject({ status: 400, cause: original });
    expect(fetch).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("HTTP400 即使 body 声称503也不可重试", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response('{"error":{"status":503}}', { status: 400 })));
    const { client } = setup({ fetch });
    await expect(collect(client.stream(input))).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["password", "Bearer", "apiKey"])("当前凭证 %s 与脱敏字段名重叠时仍保护其他凭证", async (apiKey) => {
    const fetch = vi.fn().mockRejectedValue(networkError("ECONNRESET", 'Bearer bearer-value apiKey=key-value password="pass-value"'));
    const { client, logger } = setup({ fetch });
    await expect(collect(client.stream({ ...input, apiKey }))).rejects.toMatchObject({ status: 502 });
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/bearer-value|key-value|pass-value/);
  });

  it("默认退避成功后移除所有 signal 监听器与计时器", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeExternal = vi.spyOn(controller.signal, "removeEventListener");
    let add!: ReturnType<typeof vi.spyOn>;
    let remove!: ReturnType<typeof vi.spyOn>;
    const fetch = vi.fn().mockImplementationOnce((_url: string, init: RequestInit) => {
      add = vi.spyOn(init.signal!, "addEventListener");
      remove = vi.spyOn(init.signal!, "removeEventListener");
      return Promise.reject(networkError());
    }).mockResolvedValueOnce(finish());
    const { client } = setup({ fetch, delay: undefined });
    const result = collect(client.stream({ ...input, signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(125);
    await expect(result).resolves.toEqual([{ type: "finish" }]);
    for (const [event, listener] of add.mock.calls) expect(remove).toHaveBeenCalledWith(event, listener);
    expect(removeExternal).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("超时后迟到的 fetch 响应也会取消 body", async () => {
    vi.useFakeTimers();
    let resolveFetch!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const { client } = setup({ fetch, config: loadConfig({ REQUEST_TIMEOUT_MS: "50" }) });
    const result = collect(client.stream(input)).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ status: 504 });
    const cancel = vi.fn();
    resolveFetch(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
