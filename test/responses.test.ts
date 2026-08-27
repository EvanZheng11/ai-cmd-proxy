import { describe, expect, it, vi } from "vitest";

import {
  createCommandCodeClient,
  type CommandCodeClient,
} from "../src/commandcode/client.js";
import type { CommandCodeEvent } from "../src/commandcode/types.js";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { toChatRequestFromResponses } from "../src/translate/responses.js";

function fakeClient(events: CommandCodeEvent[]): CommandCodeClient {
  return {
    async *stream() {
      yield* events;
    },
  };
}

describe("POST /v1/responses", () => {
  it("normalizes Responses input_text and input_image parts", () => {
    const result = toChatRequestFromResponses({
      model: "deepseek/deepseek-v4-flash",
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "Describe this" },
          { type: "input_image", image_url: "https://example.com/a.png" },
        ],
      }],
    });

    expect(result.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Describe this" },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ],
    });
  });

  it("normalizes flat Responses function tools", () => {
    const result = toChatRequestFromResponses({
      model: "deepseek/deepseek-v4-flash",
      input: "Use the tool",
      tools: [{
        type: "function",
        name: "lookup",
        description: "Find a record",
        parameters: { type: "object", properties: { id: { type: "string" } } },
      }],
    });

    expect(result.tools).toEqual([{
      type: "function",
      function: {
        name: "lookup",
        description: "Find a record",
        parameters: { type: "object", properties: { id: { type: "string" } } },
      },
    }]);
  });

  it("maps Responses text.format to a structured output request", () => {
    const result = toChatRequestFromResponses({
      model: "deepseek/deepseek-v4-flash",
      input: "Return JSON",
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: { type: "object", properties: { value: { type: "string" } } },
        },
      },
    });

    expect(result.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        type: "json_schema",
        name: "answer",
        schema: { type: "object", properties: { value: { type: "string" } } },
      },
    });
  });

  it("returns a Responses API output item", async () => {
    const response = await buildServer({
      commandCodeClient: fakeClient([
        { type: "text-delta", text: "TEST_OK" },
        { type: "finish", finishReason: "end_turn" },
      ]),
    }).inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer request-key" },
      payload: {
        model: "deepseek/deepseek-v4-flash",
        input: "Hi",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "response",
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "TEST_OK" }],
      }],
    });
  });

  it("returns function_call output for an upstream tool call", async () => {
    const response = await buildServer({
      commandCodeClient: fakeClient([
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "lookup",
          input: { id: "7" },
        },
        { type: "finish", finishReason: "tool-calls" },
      ]),
    }).inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer request-key" },
      payload: {
        model: "deepseek/deepseek-v4-flash",
        input: "Use lookup",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      output: [{
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{\"id\":\"7\"}",
      }],
    });
  });

  it("streams Responses lifecycle events", async () => {
    const response = await buildServer({
      commandCodeClient: fakeClient([
        { type: "text-delta", text: "TEST_OK" },
        { type: "finish", finishReason: "end_turn" },
      ]),
    }).inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer request-key" },
      payload: {
        model: "deepseek/deepseek-v4-flash",
        input: "Hi",
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("response.created");
    expect(response.body).toContain("response.output_text.delta");
    expect(response.body).toContain("response.completed");
  });

  it("rejects previous_response_id while the proxy is stateless", async () => {
    const response = await buildServer({
      commandCodeClient: fakeClient([]),
    }).inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer request-key" },
      payload: {
        model: "deepseek/deepseek-v4-flash",
        input: "Hi",
        previous_response_id: "resp_previous",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "previous_response_id_unsupported" },
    });
  });

  it("maps upstream stream errors to a non-success response", async () => {
    const response = await buildServer({
      commandCodeClient: fakeClient([
        { type: "error", error: "provider failed", statusCode: 502 },
      ]),
    }).inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer request-key" },
      payload: {
        model: "deepseek/deepseek-v4-flash",
        input: "Hi",
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: { type: "api_error", code: "upstream_error" },
    });
  });

  it("preserves an upstream HTTP error before starting a Responses stream", async () => {
    const client = createCommandCodeClient({
      config: loadConfig({}),
      fetch: vi.fn().mockResolvedValue(new Response("invalid request", { status: 400 })),
      createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-test"),
      removeTempDir: vi.fn().mockResolvedValue(undefined),
    });
    const response = await buildServer({
      commandCodeClient: client,
    }).inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer request-key" },
      payload: {
        model: "deepseek/deepseek-v4-flash",
        input: "Hi",
        stream: true,
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: { type: "api_error", code: "upstream_error" },
    });
  });

  it("cleans up the upstream client when the first streamed event is an error", async () => {
    const removeTempDir = vi.fn().mockResolvedValue(undefined);
    const app = buildServer({
      commandCodeClient: createCommandCodeClient({
        config: loadConfig({}),
        fetch: vi.fn().mockResolvedValue(new Response(
          '{"type":"error","error":"provider failed","statusCode":502}\n',
          { status: 200 },
        )),
        createTempDir: vi.fn().mockResolvedValue("/tmp/ai-cmd-proxy-test"),
        removeTempDir,
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer request-key" },
      payload: {
        model: "deepseek/deepseek-v4-flash",
        input: "Hi",
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: error');
    expect(removeTempDir).toHaveBeenCalledWith("/tmp/ai-cmd-proxy-test");
  });
});
