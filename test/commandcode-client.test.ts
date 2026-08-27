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
});
