import { request as httpRequest } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";
import { CommandCodeUpstreamError, createCommandCodeClient, type CommandCodeClient } from "../src/commandcode/client.js";
import { loadConfig } from "../src/config.js";
import type { CommandCodeEvent } from "../src/commandcode/types.js";
import { eventStatusCode } from "../src/errors.js";

const urls = ["/v1/responses", "/v1/chat/completions"];
const headers = { authorization: "Bearer private-request-key" };
function payload(url: string, stream = true) {
  return { model: "test-model", stream, ...(url.endsWith("responses")
    ? { input: "private-prompt" } : { messages: [{ role: "user", content: "private-prompt" }] }) };
}
function sse(body: string) {
  return body.split("\n").filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)));
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe.each(urls)("%s 生命周期", (url) => {
  it.each([
    { type: "text-delta", text: "" },
    { type: "reasoning-delta", text: "" },
    { type: "text-delta" },
    { type: "reasoning-delta" },
  ])("忽略无有效内容的 $type ($text)，后续错误仍返回 HTTP 429", async (event) => {
    const returned = vi.fn();
    const app = buildServer({ logger: false, commandCodeClient: { async *stream() {
      try {
        yield event;
        yield { type: "error", statusCode: 429, error: "rate limited" };
      } finally { returned(); }
    } } });
    try {
      const response = await app.inject({ method: "POST", url, headers, payload: payload(url) });
      expect(response.statusCode).toBe(429);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.json().error).toMatchObject({ message: "rate limited", type: "rate_limit_error" });
      expect(returned).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });

  it.each([400, 401, 403, 429, 502, 503, 504])("首事件或元事件之后的错误保留 HTTP %i", async (status) => {
    for (const prefix of [[], [{ type: "start" }, { type: "start-step" }]]) {
      for (const type of ["error", "abort"]) {
        const returned = vi.fn();
        const app = buildServer({ logger: false, commandCodeClient: { async *stream() {
          try { yield* prefix; yield { type, error: { message: "provider rejected", status } } as CommandCodeEvent; }
          finally { returned(); }
        } } });
        try {
          const response = await app.inject({ method: "POST", url, headers, payload: payload(url) });
          expect(response.statusCode).toBe(status);
          expect(response.json().error.message).toBe("provider rejected");
          expect(returned).toHaveBeenCalledOnce();
        } finally { await app.close(); }
      }
    }
  });

  it.each([false, true])("预读 transport 错误也归还 iterator，元事件=%s", async (metadata) => {
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    let count = 0;
    const app = buildServer({ logger: false, commandCodeClient: { stream: () => ({
      [Symbol.asyncIterator]: () => ({ return: returned, next: async () => {
        if (metadata && count++ === 0) return { done: false, value: { type: "start" } };
        throw new CommandCodeUpstreamError("malformed NDJSON", 502);
      } }),
    }) } });
    try {
      const response = await app.inject({ method: "POST", url, headers, payload: payload(url) });
      expect(response.statusCode).toBe(502);
      expect(response.json().error.message).toBe("malformed NDJSON");
      expect(returned).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });

  it.each([false, true])("注入 iterator 的原始协议异常返回 502，stream=%s", async (stream) => {
    const returned = vi.fn();
    const app = buildServer({ logger: false, commandCodeClient: { async *stream() {
      try {
        yield { type: "start" };
        throw new SyntaxError("invalid protocol payload");
      } finally { returned(); }
    } } });
    try {
      const response = await app.inject({ method: "POST", url, headers, payload: payload(url, stream) });
      expect(response.statusCode).toBe(502);
      expect(response.json().error.type).toBe("api_error");
      expect(returned).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });

  it.each(["event", "transport"])("流中 %s 错误正确终止并记录脱敏日志", async (kind) => {
    const output = new PassThrough();
    let logs = "";
    output.on("data", (chunk) => { logs += chunk.toString(); });
    const app = buildServer({ logger: { stream: output, level: "info" }, commandCodeClient: { async *stream() {
      yield { type: "text-delta", text: "partial" };
      const message = "failed private-request-key Bearer another-secret";
      if (kind === "transport") throw new CommandCodeUpstreamError(message, 503);
      yield { type: "error", statusCode: 503, error: message };
    } } });
    try {
      const response = await app.inject({ method: "POST", url, headers, payload: payload(url) });
      expect(response.statusCode).toBe(200);
      const events = sse(response.body);
      if (url.endsWith("responses")) {
        const failed = events.at(-1);
        expect(failed.type).toBe("response.failed");
        expect(failed.response.id).toBe(events[0].response.id);
        expect(failed.response.status).toBe("failed");
        expect(failed.response.error.status_code).toBe(503);
        expect(response.body).not.toContain("response.completed");
      } else {
        expect(events.at(-1).error.code).toBe("upstream_error");
        expect(response.body).toMatch(/data: \[DONE\]\n\n$/);
      }
      const errors = logs.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((log) => log.level === 50);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].requestId).toBe(response.headers["x-request-id"]);
      expect(logs).not.toContain("private-request-key");
      expect(logs).not.toContain("another-secret");
      expect(logs).not.toContain("private-prompt");
    } finally { await app.close(); }
  });

  it.each([false, true])("成功响应关联 requestId 且不取消 signal，stream=%s", async (stream) => {
    let input!: Parameters<CommandCodeClient["stream"]>[0];
    const app = buildServer({ logger: false, commandCodeClient: { async *stream(value) {
      input = value;
      yield { type: "finish" };
    } } });
    try {
      const response = await app.inject({ method: "POST", url, headers, payload: payload(url, stream) });
      expect(response.statusCode).toBe(200);
      expect(input.requestId).toBeTruthy();
      expect(response.headers["x-request-id"]).toBe(input.requestId);
      expect(input.signal?.aborted).toBe(false);
    } finally { await app.close(); }
  });

  it("Zod 错误给出具体字段路径", async () => {
    const app = buildServer({ logger: false, commandCodeClient: { stream: vi.fn() } });
    try {
      const response = await app.inject({ method: "POST", url, headers, payload: { ...payload(url), model: 123 } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.param).toBe("model");
    } finally { await app.close(); }
  });

  it("嵌套 Zod union 错误给出具体工具字段", async () => {
    const tool = url.endsWith("responses") ? { type: "function", name: 123 }
      : { type: "function", function: { name: 123 } };
    const app = buildServer({ logger: false, commandCodeClient: { stream: vi.fn() } });
    try {
      const response = await app.inject({ method: "POST", url, headers, payload: { ...payload(url), tools: [tool] } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.param).toBe(url.endsWith("responses") ? "tools[0].name" : "tools[0].function.name");
    } finally { await app.close(); }
  });

  it.each(["text-delta", "reasoning-delta", "tool-call", "finish"])("只预读至首个 %s，后续读取发生在提交 HTTP 后", async (type) => {
    let rawReply: import("node:http").ServerResponse | undefined;
    const returned = vi.fn();
    const observations: boolean[] = [];
    const app = buildServer({ logger: false, commandCodeClient: { async *stream() {
      try {
        yield { type: "start" };
        yield { type: "start-step" };
        observations.push(rawReply!.headersSent);
        yield { type, text: "first", toolName: "read", toolCallId: "call_1", input: {} };
        observations.push(rawReply!.headersSent);
        if (type !== "finish") yield { type: "finish" };
      } finally { returned(); }
    } } });
    app.addHook("onRequest", async (_request, reply) => { rawReply = reply.raw; });
    try {
      const response = await app.inject({ method: "POST", url, headers, payload: payload(url) });
      expect(response.statusCode).toBe(200);
      expect(observations).toEqual([false, true]);
      expect(returned).toHaveBeenCalledOnce();
      expect(rawReply!.listenerCount("close")).toBe(0);
    } finally { await app.close(); }
  });

  it.each([false, true])("真实 client 的挂起 reader 在 socket 销毁后取消，已输出=%s", async (started) => {
    const entered = deferred();
    const received = deferred();
    let upstreamSignal: AbortSignal | undefined;
    const cancel = vi.fn();
    const client = createCommandCodeClient({
      config: { ...loadConfig({}), requestTimeoutMs: 3000 },
      createTempDir: async () => "/tmp/injected-route-test",
      logger: () => {},
      fetch: async (_url, init) => {
        upstreamSignal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (started) controller.enqueue(new TextEncoder().encode('{"type":"text-delta","text":"partial"}\n'));
            entered.resolve();
          },
          cancel,
        });
        return new Response(body);
      },
    });
    const app = buildServer({ logger: false, commandCodeClient: client });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const request = httpRequest(`${address}${url}`, { method: "POST", headers: { ...headers, "content-type": "application/json" } }, (response) => {
      response.once("data", () => received.resolve());
      response.on("error", () => {});
    });
    request.on("error", () => {});
    request.end(JSON.stringify(payload(url)));
    try {
      await entered.promise;
      if (started) await received.promise;
      expect(upstreamSignal?.aborted).toBe(false);
      request.destroy();
      await vi.waitFor(() => {
        expect(upstreamSignal?.aborted).toBe(true);
        expect(cancel).toHaveBeenCalledOnce();
      }, { timeout: 1000 });
    } finally { request.destroy(); await app.close(); }
  });

  it.each([false, true])("真实 HTTP socket 销毁取消上游，已输出=%s", async (started) => {
    const entered = deferred();
    const cleaned = deferred();
    let signal: AbortSignal | undefined;
    let rawReply: import("node:http").ServerResponse | undefined;
    const app = buildServer({ logger: false, commandCodeClient: { async *stream(input) {
      signal = input.signal;
      try {
        if (started) yield { type: "text-delta", text: "partial" };
        entered.resolve();
        await new Promise((_, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
        });
      } finally { cleaned.resolve(); }
    } } });
    app.addHook("onRequest", async (_request, reply) => { rawReply = reply.raw; });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const received = deferred();
    const request = httpRequest(`${address}${url}`, { method: "POST", headers: { ...headers, "content-type": "application/json" } }, (response) => {
      response.once("data", () => received.resolve());
      response.on("error", () => {});
    });
    request.on("error", () => {});
    request.end(JSON.stringify(payload(url)));
    try {
      await entered.promise;
      if (started) await received.promise;
      expect(signal?.aborted).toBe(false);
      const write = vi.spyOn(rawReply!, "write");
      request.destroy();
      await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 1000 });
      await cleaned.promise;
      await vi.waitFor(() => expect(rawReply!.listenerCount("close")).toBe(0));
      expect(write).not.toHaveBeenCalled();
    } finally { request.destroy(); await app.close(); }
  });
});

it.each([
  [{ status: 429 }, 429], [{ error: { status: 403 } }, 403],
  [{ statusCode: 700 }, 502], [{ error: { statusCode: 600 } }, 502],
  [{ statusCode: 400.5 }, 502], [{ statusCode: 200, error: { status: 401 } }, 401],
])("只接受有效错误 HTTP 状态：%j", (event, expected) => {
  expect(eventStatusCode(event)).toBe(expected);
});

it("Responses 翻译错误保留 code 和 param", async () => {
  const app = buildServer({ logger: false, commandCodeClient: { stream: vi.fn() } });
  try {
    const response = await app.inject({ method: "POST", url: urls[0], headers,
      payload: { ...payload(urls[0]), tools: [{ type: "web_search" }] } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: "unsupported_tool_type", param: "tools[0].type" });
  } finally { await app.close(); }
});

it("Responses tools 本身无效也保留字段名", async () => {
  const app = buildServer({ logger: false, commandCodeClient: { stream: vi.fn() } });
  try {
    const response = await app.inject({ method: "POST", url: urls[0], headers,
      payload: { ...payload(urls[0]), tools: "invalid" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.param).toBe("tools");
  } finally { await app.close(); }
});

it.each([false, true])("Responses namespace 工具输出恢复原名，stream=%s", async (stream) => {
  const app = buildServer({ logger: false, commandCodeClient: { async *stream(input) {
    yield { type: "tool-call", toolCallId: "call_1", toolName: input.request.params.tools?.[0]?.name, input: {} };
    yield { type: "finish" };
  } } });
  try {
    const response = await app.inject({ method: "POST", url: urls[0], headers, payload: {
      ...payload(urls[0], stream), tools: [{ type: "namespace", name: "files", tools: [{ type: "function", name: "read" }] }],
    } });
    const result = stream ? sse(response.body).at(-1).response : response.json();
    expect(result.output[0]).toMatchObject({ type: "function_call", name: "read", namespace: "files" });
  } finally { await app.close(); }
});
