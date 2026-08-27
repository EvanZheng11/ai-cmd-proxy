import { describe, expect, it, vi } from "vitest";

import { extractCredential, redactHeaders } from "../src/auth.js";
import { createCommandCodeClient } from "../src/commandcode/client.js";
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
    expect(removeTempDir).toHaveBeenCalledWith("/tmp/ai-cmd-proxy-random");
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
      "CommandCode 响应已收到",
    ]);
    expect(JSON.stringify(logger.mock.calls)).not.toContain("request-secret");
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

    expect(removeTempDir).toHaveBeenCalledWith("/tmp/ai-cmd-proxy-random");
  });

  it("cleans up when session creation fails", async () => {
    const removeTempDir = vi.fn().mockResolvedValue(undefined);
    const client = createCommandCodeClient({
      config: loadConfig({}),
      createSessionId: vi.fn(() => {
        throw new Error("session creation failed");
      }),
      createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-random"),
      removeTempDir,
    });

    await expect(collect(client.stream({
      apiKey: "request-secret",
      request: sampleRequest,
    }))).rejects.toMatchObject({
      name: "CommandCodeUpstreamError",
      status: 502,
    });

    expect(removeTempDir).toHaveBeenCalledWith("/tmp/ai-cmd-proxy-random");
  });

  it("preserves the upstream error when temporary directory cleanup fails", async () => {
    const client = createCommandCodeClient({
      config: loadConfig({}),
      fetch: vi.fn().mockResolvedValue(new Response("not-json\n", { status: 200 })),
      createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-random"),
      removeTempDir: vi.fn().mockRejectedValue(new Error("cleanup failed")),
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
      "CommandCode 请求失败",
    ]);
    expect(JSON.stringify(logger.mock.calls)).not.toContain("request-secret");
  });
});
