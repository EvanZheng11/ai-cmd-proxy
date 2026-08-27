import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  CommandCodeUpstreamError,
  type CommandCodeClient,
} from "../src/commandcode/client.js";
import type { CommandCodeEvent } from "../src/commandcode/types.js";
import { buildServer } from "../src/server.js";

function fakeClient(events: CommandCodeEvent[]): CommandCodeClient {
  return {
    async *stream() {
      yield* events;
    },
  };
}

describe("POST /v1/chat/completions", () => {
  it("returns a non-streaming Chat Completion", async () => {
    const app = buildServer({
      commandCodeClient: fakeClient([
        { type: "text-delta", text: "TEST_OK" },
        {
          type: "finish",
          finishReason: "end_turn",
          totalUsage: { inputTokens: 4, outputTokens: 2 },
        },
      ]),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer request-key" },
      payload: {
        model: "deepseek/deepseek-v4-flash",
        messages: [{ role: "user", content: "Hi" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "chat.completion",
      choices: [{
        message: { role: "assistant", content: "TEST_OK" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });
  });

  it("returns [DONE] after streaming chat completion chunks", async () => {
    const app = buildServer({
      commandCodeClient: fakeClient([
        { type: "text-delta", text: "TEST_OK" },
        { type: "finish", finishReason: "end_turn" },
      ]),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer request-key" },
      payload: {
        model: "deepseek/deepseek-v4-flash",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain('"content":"TEST_OK"');
    expect(response.body).toContain("data: [DONE]");
    expect(response.body.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("rejects requests without a credential", async () => {
    const response = await buildServer({
      commandCodeClient: fakeClient([]),
    }).inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "deepseek/deepseek-v4-flash",
        messages: [{ role: "user", content: "Hi" }],
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { type: "authentication_error" },
    });
  });

  it("maps an upstream authentication failure to an OpenAI authentication error", async () => {
    const response = await buildServer({
      commandCodeClient: {
        async *stream() {
          throw new CommandCodeUpstreamError("CommandCode returned HTTP 401", 401);
        },
      },
    }).inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer request-key" },
      payload: {
        model: "deepseek/deepseek-v4-flash",
        messages: [{ role: "user", content: "Hi" }],
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { type: "authentication_error", code: "upstream_authentication" },
    });
  });

  it("maps an upstream stream error instead of returning a successful completion", async () => {
    const response = await buildServer({
      commandCodeClient: fakeClient([
        { type: "error", error: "provider failed", statusCode: 502 },
      ]),
    }).inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer request-key" },
      payload: {
        model: "deepseek/deepseek-v4-flash",
        messages: [{ role: "user", content: "Hi" }],
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: { type: "api_error", code: "upstream_error" },
    });
  });

  it("logs request path, status, and elapsed time without the raw authorization", async () => {
    const authorization = "Bearer test-secret-token";
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk: Buffer) => lines.push(chunk.toString()));

    // 该参数表达 buildServer 应暴露的最小 logger 配置公共行为。
    // @ts-expect-error buildServer 当前尚未接受 logger 配置。
    const app = buildServer({
      commandCodeClient: {
        async *stream() {
          throw new CommandCodeUpstreamError("CommandCode returned HTTP 502", 502);
        },
      },
      logger: { level: "info", stream: output },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions?token=do-not-log",
      headers: { authorization },
      payload: {
        model: "deepseek/deepseek-v4-flash",
        messages: [{ role: "user", content: "Hi" }],
      },
    });
    await app.close();

    const requestLog = lines
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        req?: { url?: string };
        res?: { statusCode?: number };
        responseTime?: number;
      })
      .find((record) => record.req?.url === "/v1/chat/completions");

    expect(response.statusCode).toBe(502);
    expect(lines.join("")).not.toContain("do-not-log");
    expect(lines.join("")).not.toContain(authorization);
    expect(requestLog).toEqual(expect.objectContaining({
      req: expect.objectContaining({ url: "/v1/chat/completions" }),
      res: expect.objectContaining({ statusCode: 502 }),
      responseTime: expect.any(Number),
    }));
  });

  it("returns an OpenAI error for malformed JSON", async () => {
    const response = await buildServer({
      commandCodeClient: fakeClient([]),
    }).inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer request-key",
        "content-type": "application/json",
      },
      payload: "{\"model\":",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { type: "invalid_request_error" },
    });
  });
});
