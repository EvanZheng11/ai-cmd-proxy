import { describe, expect, it, vi } from "vitest";

import { extractCredential, redactHeaders } from "../src/auth.js";
import { createCommandCodeClient, upstreamErrorStatus } from "../src/commandcode/client.js";
import type { CommandCodeGenerateInput } from "../src/commandcode/types.js";
import { loadConfig } from "../src/config.js";

const sampleRequest: CommandCodeGenerateInput = {
  memory: null,
  taste: null,
  skills: null,
  permissionMode: "standard",
  mode: "agent",
  params: {
    model: "deepseek/deepseek-v4-flash",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    system: "",
    max_tokens: 256,
    stream: true,
  },
};

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

describe("request credentials", () => {
  it("prefers a bearer credential and redacts credential headers", () => {
    expect(
      extractCredential({
        authorization: "Bearer request-secret",
        "x-commandcode-api-key": "fallback-secret",
      }),
    ).toBe("request-secret");

    expect(
      redactHeaders({
        authorization: "Bearer request-secret",
        "x-commandcode-api-key": "fallback-secret",
        accept: "application/json",
      }),
    ).toEqual({
      authorization: "[REDACTED]",
      "x-commandcode-api-key": "[REDACTED]",
      accept: "application/json",
    });
  });
});

describe("CommandCode client", () => {
  it("sends required headers, builds a temporary working directory, parses NDJSON, and cleans up", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        '{"type":"text-delta","text":"OK"}\n{"type":"finish","finishReason":"end_turn","totalUsage":{"inputTokens":4,"outputTokens":2}}\n',
        { status: 200 },
      ),
    );
    const createTempDir = vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-random");
    const removeTempDir = vi.fn().mockResolvedValue(undefined);
    const client = createCommandCodeClient({
      config: loadConfig({}),
      fetch: fetchMock,
      createTempDir,
      removeTempDir,
      now: () => new Date("2026-08-27T12:00:00.000Z"),
      platform: () => "darwin",
    });

    const events = await collect(
      client.stream({
        apiKey: "request-secret",
        request: sampleRequest,
      }),
    );

    expect(events).toEqual([
      { type: "text-delta", text: "OK" },
      {
        type: "finish",
        finishReason: "end_turn",
        totalUsage: { inputTokens: 4, outputTokens: 2 },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.commandcode.ai/alpha/generate",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer request-secret",
          "user-agent": "cli",
          "x-command-code-version": "1.36.0",
          "x-cli-environment": "production",
          "x-taste-learning": "true",
        }),
      }),
    );

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(requestInit.body));
    expect(payload.config).toMatchObject({
      workingDir: "/tmp/ai-cmd-proxy-random",
      date: "2026-08-27",
      environment: "darwin",
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    });
    expect(createTempDir).toHaveBeenCalledOnce();
    expect(removeTempDir).not.toHaveBeenCalled();
  });

  it("reuses one working directory across requests for cache-prefix stability", async () => {
    // 每次请求都要拿到独立的 Response 实例（body 只能消费一次）。
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response('{"type":"finish","finishReason":"end_turn"}\n', { status: 200 }),
    ));
    const createTempDir = vi.fn()
      .mockResolvedValueOnce("/tmp/ai-cmd-proxy-first")
      .mockResolvedValue("/tmp/ai-cmd-proxy-second");
    const client = createCommandCodeClient({
      config: loadConfig({}),
      fetch: fetchMock,
      createTempDir,
      removeTempDir: vi.fn().mockResolvedValue(undefined),
    });

    await collect(client.stream({ apiKey: "k", request: sampleRequest }));
    await collect(client.stream({ apiKey: "k", request: sampleRequest }));

    expect(createTempDir).toHaveBeenCalledOnce();
    const second = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(second.config.workingDir).toBe("/tmp/ai-cmd-proxy-first");
  });

  it("caps the default max tokens at CommandCode's validation limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        '{"type":"finish","finishReason":"end_turn"}\n',
        { status: 200 },
      ),
    );
    const client = createCommandCodeClient({
      config: loadConfig({}),
      fetch: fetchMock,
      createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-random"),
      removeTempDir: vi.fn().mockResolvedValue(undefined),
    });

    await collect(client.stream({
      apiKey: "request-secret",
      request: {
        ...sampleRequest,
        params: { ...sampleRequest.params, max_tokens: 1_000_000 },
      },
    }));

    const payload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(payload.params.max_tokens).toBe(200_000);
  });

  it("maps malformed NDJSON to an upstream error", async () => {
    const client = createCommandCodeClient({
      config: loadConfig({}),
      fetch: vi.fn().mockResolvedValue(new Response("not-json\n", { status: 200 })),
      createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-random"),
      removeTempDir: vi.fn().mockResolvedValue(undefined),
    });

    await expect(collect(client.stream({
      apiKey: "request-secret",
      request: sampleRequest,
    }))).rejects.toMatchObject({
      name: "CommandCodeUpstreamError",
      status: 502,
    });
  });

  it("logs sanitized upstream request parameters and error response details", async () => {
    const logger = vi.fn();
    const client = createCommandCodeClient({
      config: loadConfig({}),
      fetch: vi.fn().mockResolvedValue(new Response(
        '{"error":{"message":"Invalid input","code":"invalid_request"}}',
        {
          status: 400,
          headers: { "x-request-id": "upstream-request-1" },
        },
      )),
      createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-random"),
      removeTempDir: vi.fn().mockResolvedValue(undefined),
      logger,
    });

    await expect(collect(client.stream({
      apiKey: "request-secret",
      request: sampleRequest,
    }))).rejects.toMatchObject({ status: 400 });

    const requestLog = logger.mock.calls.find(([message]) => message === "CommandCode 上游请求参数");
    const responseLog = logger.mock.calls.find(([message]) => message === "CommandCode 上游响应详情");
    expect(requestLog?.[1]).toMatchObject({
      url: "https://api.commandcode.ai/alpha/generate",
      method: "POST",
      headers: expect.objectContaining({ authorization: "[REDACTED]" }),
      body: expect.stringContaining(`"model":"${sampleRequest.params.model}"`),
    });
    expect(responseLog?.[1]).toMatchObject({
      status: 400,
      headers: expect.objectContaining({ "x-request-id": "upstream-request-1" }),
      body: expect.stringContaining("Invalid input"),
    });
    expect(JSON.stringify(logger.mock.calls)).not.toContain("request-secret");
  });

  it("logs image metadata without base64 image data", async () => {
    const logger = vi.fn();
    const client = createCommandCodeClient({
      config: loadConfig({}),
      fetch: vi.fn().mockResolvedValue(new Response(
        '{"type":"finish","finishReason":"end_turn"}\n',
        { status: 200 },
      )),
      createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-random"),
      removeTempDir: vi.fn().mockResolvedValue(undefined),
      logger,
    });

    await collect(client.stream({
      apiKey: "request-secret",
      request: {
        ...sampleRequest,
        params: {
          ...sampleRequest.params,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "Describe this" },
              { type: "image", image: "data:image/png;base64,aGVsbG8=", mediaType: "image/png" },
            ],
          }],
        },
      },
    }));

    expect(logger.mock.calls).toContainEqual([
      "CommandCode 图片参数摘要",
      {
        imageCount: 1,
        images: [{ mediaType: "image/png", base64Length: 8 }],
      },
    ]);
    expect(JSON.stringify(logger.mock.calls)).not.toContain("aGVsbG8=");
  });

  it("maps an upstream timeout to status 504", async () => {
    const client = createCommandCodeClient({
      config: loadConfig({}),
      fetch: vi.fn().mockRejectedValue(new DOMException("Timed out", "TimeoutError")),
      createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-random"),
      removeTempDir: vi.fn().mockResolvedValue(undefined),
    });

    await expect(collect(client.stream({
      apiKey: "request-secret",
      request: sampleRequest,
    }))).rejects.toMatchObject({
      name: "CommandCodeUpstreamError",
      status: 504,
    });
  });

  it.each([
    ["an empty response body", ""],
    ["a response without a finish event", '{"type":"text-delta","text":"OK"}\n'],
  ])("maps %s to an upstream 502 error", async (_description, body) => {
    const client = createCommandCodeClient({
      config: loadConfig({}),
      fetch: vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
      createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-random"),
      removeTempDir: vi.fn().mockResolvedValue(undefined),
    });

    await expect(collect(client.stream({
      apiKey: "request-secret",
      request: sampleRequest,
    }))).rejects.toMatchObject({
      name: "CommandCodeUpstreamError",
      status: 502,
    });
  });

  it.each([
    ["an error event", '{"type":"error","error":"unauthorized","statusCode":401}\n'],
    ["an abort event", '{"type":"abort","error":"aborted","statusCode":499}\n'],
  ])("preserves %s as a terminal upstream event", async (_description, body) => {
    const client = createCommandCodeClient({
      config: loadConfig({}),
      fetch: vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
      createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-random"),
      removeTempDir: vi.fn().mockResolvedValue(undefined),
    });

    await expect(collect(client.stream({
      apiKey: "request-secret",
      request: sampleRequest,
    }))).resolves.toHaveLength(1);
  });

  it("preserves the upstream HTTP status and structured error body", async () => {
    // 真实上游对套餐限制回 403，并把原因放在结构化响应体里。
    const client = createCommandCodeClient({
      config: loadConfig({}),
      fetch: vi.fn().mockResolvedValue(new Response(
        '{"success":false,"error":{"code":"FORBIDDEN","status":403,"message":"MODEL_NOT_IN_PLAN: Claude Sonnet 5"}}',
        { status: 403 },
      )),
      createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-random"),
      removeTempDir: vi.fn().mockResolvedValue(undefined),
    });

    await expect(collect(client.stream({
      apiKey: "request-secret",
      request: sampleRequest,
    }))).rejects.toMatchObject({
      name: "CommandCodeUpstreamError",
      status: 403,
    });
  });

  it.each([
    ['{"success":false,"error":{"code":"FORBIDDEN","status":403}}', 403],
    ['{"type":"error","error":"bad","statusCode":400}', 400],
    ['{"status":429}', 429],
    ['{"message":"opaque failure"}', 502],
    ['not json at all', 502],
    [undefined, 502],
  ])("extracts a status from %s", (body, expected) => {
    expect(upstreamErrorStatus(body, 502)).toBe(expected);
  });

  it("cancels an upstream body after receiving a terminal event", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          '{"type":"finish","finishReason":"end_turn"}\n',
        ));
      },
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    });
    const client = createCommandCodeClient({
      config: loadConfig({ REQUEST_TIMEOUT_MS: "100" }),
      fetch: vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
      createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-random"),
      removeTempDir: vi.fn().mockResolvedValue(undefined),
    });

    const iterator = client.stream({
      apiKey: "request-secret",
      request: sampleRequest,
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "finish", finishReason: "end_turn" },
    });

    expect(cancelled).toBe(true);
    await iterator.return?.();
  });

  it("logs request start and response without exposing the api key", async () => {
    const logger = vi.fn();
    const client = createCommandCodeClient({
      config: loadConfig({}),
      fetch: vi.fn().mockResolvedValue(
        new Response(
          '{"type":"text-delta","text":"OK"}\n{"type":"finish","finishReason":"end_turn"}\n',
          { status: 200 },
        ),
      ),
      createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-random"),
      removeTempDir: vi.fn().mockResolvedValue(undefined),
      logger,
    });

    await collect(
      client.stream({
        apiKey: "request-secret",
        request: sampleRequest,
      }),
    );

    expect(logger.mock.calls.map(([message]) => message)).toEqual([
      "CommandCode 请求开始",
      "CommandCode 上游请求参数",
      "CommandCode 上游响应详情",
      "CommandCode 响应已收到",
      "CommandCode 上游响应体",
      "CommandCode 缓存命中统计",
    ]);
    await vi.waitFor(() => {
      expect(logger.mock.calls).toContainEqual([
        "CommandCode 上游响应体",
        expect.objectContaining({
          body: expect.stringContaining('"text":"OK"'),
        }),
      ]);
    });
    expect(JSON.stringify(logger.mock.calls)).not.toContain("request-secret");
  });

  it("summarizes upstream cache hits in the log", async () => {
    const logger = vi.fn();
    const client = createCommandCodeClient({
      config: loadConfig({}),
      fetch: vi.fn().mockResolvedValue(new Response(
        '{"type":"finish","totalUsage":{"inputTokens":4367,"cachedInputTokens":4224}}\n',
        { status: 200 },
      )),
      createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-random"),
      removeTempDir: vi.fn().mockResolvedValue(undefined),
      logger,
    });

    await collect(client.stream({
      apiKey: "request-secret",
      request: sampleRequest,
    }));

    expect(logger.mock.calls).toContainEqual([
      "CommandCode 缓存命中统计",
      { inputTokens: 4367, cachedInputTokens: 4224, cacheHitRate: "97%" },
    ]);
  });

  it("removes the temporary directory when the logger throws", async () => {
    const logger = vi.fn().mockImplementation(() => {
      throw new Error("logger failed");
    });
    const removeTempDir = vi.fn().mockResolvedValue(undefined);
    const client = createCommandCodeClient({
      config: loadConfig({}),
      fetch: vi.fn().mockResolvedValue(
        new Response(
          '{"type":"text-delta","text":"OK"}\n{"type":"finish","finishReason":"end_turn"}\n',
          { status: 200 },
        ),
      ),
      createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-random"),
      removeTempDir,
      logger,
    });

    await expect(collect(client.stream({
      apiKey: "request-secret",
      request: sampleRequest,
    }))).resolves.toEqual([
      { type: "text-delta", text: "OK" },
      { type: "finish", finishReason: "end_turn" },
    ]);

    // 固定 workingDir 的生命周期与客户端实例一致，日志故障不应触发清理。
    expect(removeTempDir).not.toHaveBeenCalled();
  });

  it("cleans up when session creation fails", async () => {
    const removeTempDir = vi.fn().mockResolvedValue(undefined);
    const client = createCommandCodeClient({
      config: loadConfig({}),
      createSessionId: vi.fn(() => {
        throw new Error("session creation failed");
      }),
      createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-random"),
      removeTempDir: vi.fn().mockResolvedValue(undefined),
    });

    await expect(collect(client.stream({
      apiKey: "request-secret",
      request: sampleRequest,
    }))).rejects.toMatchObject({
      name: "CommandCodeUpstreamError",
      status: 502,
    });

    // 固定 workingDir 不再随请求清理。
    expect(removeTempDir).not.toHaveBeenCalled();
  });
  it("preserves the upstream error when temporary directory cleanup fails", async () => {
    const client = createCommandCodeClient({
      config: loadConfig({}),
      fetch: vi.fn().mockResolvedValue(new Response("not-json\n", { status: 200 })),
      createTempDir: vi.fn().mockRejectedValue(new Error("mkdtemp failed")),
      removeTempDir: vi.fn().mockResolvedValue(undefined),
      logger: vi.fn(),
    });

    await expect(collect(client.stream({
      apiKey: "request-secret",
      request: sampleRequest,
    }))).rejects.toMatchObject({
      name: "CommandCodeUpstreamError",
      status: 502,
    });
  });

  it("retries working directory creation after a failed attempt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"type":"finish","finishReason":"end_turn"}\n', { status: 200 }),
    );
    const createTempDir = vi.fn()
      .mockRejectedValueOnce(new Error("mkdtemp failed"))
      .mockResolvedValue("/tmp/ai-cmd-proxy-recovered");
    const client = createCommandCodeClient({
      config: loadConfig({}),
      fetch: fetchMock,
      createTempDir,
      removeTempDir: vi.fn().mockResolvedValue(undefined),
    });

    await expect(collect(client.stream({
      apiKey: "k",
      request: sampleRequest,
    }))).rejects.toMatchObject({ name: "CommandCodeUpstreamError" });
    await collect(client.stream({ apiKey: "k", request: sampleRequest }));

    expect(createTempDir).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(payload.config.workingDir).toBe("/tmp/ai-cmd-proxy-recovered");
  });

  it("logs request failures without exposing the api key", async () => {
    const logger = vi.fn();
    const client = createCommandCodeClient({
      config: loadConfig({}),
      fetch: vi.fn().mockRejectedValue(new Error("socket closed")),
      createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-random"),
      removeTempDir: vi.fn().mockResolvedValue(undefined),
      logger,
    });

    await expect(
      collect(
        client.stream({
          apiKey: "request-secret",
          request: sampleRequest,
        }),
      ),
    ).rejects.toMatchObject({
      name: "CommandCodeUpstreamError",
      status: 502,
    });

    expect(logger.mock.calls.map(([message]) => message)).toEqual([
      "CommandCode 请求开始",
      "CommandCode 上游请求参数",
      "CommandCode 请求失败",
    ]);
    expect(JSON.stringify(logger.mock.calls)).not.toContain("request-secret");
  });
});
