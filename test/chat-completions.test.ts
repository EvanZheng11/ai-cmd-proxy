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
});
