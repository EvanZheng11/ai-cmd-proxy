import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

import {
  createCommandCodeClient,
  type CommandCodeClient,
} from "../src/commandcode/client.js";
import type { CommandCodeEvent } from "../src/commandcode/types.js";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { toCommandCodeGenerateRequest } from "../src/translate/generate-request.js";
import { toChatRequestFromResponses } from "../src/translate/responses.js";

function fakeClient(events: CommandCodeEvent[]): CommandCodeClient {
  return {
    async *stream() {
      yield* events;
    },
  };
}

describe("POST /v1/responses", () => {
  it("preserves explicit text format and empty instructions", () => {
    const request = toChatRequestFromResponses({
      model: "test-model",
      instructions: "",
      input: "  hello\n",
      text: { format: { type: "text" } },
    });
    expect(request.messages).toEqual([
      { role: "system", content: "" },
      { role: "user", content: "  hello\n" },
    ]);
    expect(toCommandCodeGenerateRequest(request).params.system).toBe("");
  });

  it.each([
    ["/v1/chat/completions", { messages: [{ role: "user", content: "Hello" }], response_format: { type: "json_object" } }],
    ["/v1/chat/completions", { messages: [{ role: "user", content: "Hello" }], response_format: { type: "json_schema", json_schema: { name: "answer", schema: { type: "object" } } } }],
    ["/v1/responses", { input: "Hello", text: { format: { type: "json_schema", name: "answer", schema: { type: "object" } } } }],
  ])("rejects structured output before calling upstream at %s", async (url, payload) => {
    const stream = vi.fn();
    const app = buildServer({ commandCodeClient: { stream } });
    try {
      const response = await app.inject({
        method: "POST", url,
        headers: { authorization: "Bearer request-key" },
        payload: { model: "test-model", ...payload },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("Structured output");
      expect(stream).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

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

  it("converts an OpenAI Responses image_url data URL into a CommandCode image", () => {
    const request = toCommandCodeGenerateRequest(toChatRequestFromResponses({
      model: "deepseek/deepseek-v4-flash-vision-exp",
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "Describe this image" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,aGVsbG8=",
            detail: "high",
          },
        ],
      }],
    }));

    expect(request.params.messages[0]?.content).toEqual([
      { type: "text", text: "Describe this image" },
      { type: "image", image: "data:image/png;base64,aGVsbG8=", mediaType: "image/png" },
    ]);
  });

  it("preserves OpenAI image_url parts in Responses role messages", () => {
    const request = toCommandCodeGenerateRequest(toChatRequestFromResponses({
      model: "deepseek/deepseek-v4-flash-vision-exp",
      input: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image" },
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64,aGVsbG8=" },
          },
        ],
      }],
    }));

    expect(request.params.messages[0]?.content).toEqual([
      { type: "text", text: "Describe this image" },
      { type: "image", image: "data:image/jpeg;base64,aGVsbG8=", mediaType: "image/jpeg" },
    ]);
  });

  it("rejects OpenAI Responses image file_id inputs", async () => {
    const response = await buildServer({
      commandCodeClient: fakeClient([]),
    }).inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer request-key" },
      payload: {
        model: "deepseek/deepseek-v4-flash-vision-exp",
        input: [{
          role: "user",
          content: [{ type: "input_image", file_id: "file_image" }],
        }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "unsupported_image_file_id",
      },
    });
  });

  it("keeps role-less shorthand items (function_call/output, reasoning) in history", () => {
    // DeepSeek Harness 等下游会把历史作为不带 role 的简写条目回传：
    // function_call / function_call_output / reasoning。只按 role 分流的实现
    // 会把它们全部丢弃，第二轮起上游就看不到完整历史。
    const result = toChatRequestFromResponses({
      model: "deepseek/deepseek-v4.1-flash",
      input: [
        {
          role: "system",
          content: "You are an AI agent.",
        },
        { role: "user", content: "第一轮问题" },
        {
          type: "function_call",
          call_id: "call_00_abc",
          name: "bash",
          arguments: "{\"command\":\"ls\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_00_abc",
          output: "file-a\nfile-b",
        },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "先看目录结构" }],
        },
        {
          type: "function_call",
          call_id: "call_01_def",
          name: "read",
          arguments: "{\"file_path\":\"a.ts\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_01_def",
          output: "content",
        },
        { role: "user", content: "继续" },
      ],
    });

    // 无 type 的 {"role":"user","content":...} 走 message 转换；
    // system/developer 会在后续 toCommandCodeMessages 里合并为 system。
    expect(result.messages).toEqual([
      { role: "assistant", content: "You are an AI agent." },
      { role: "user", content: "第一轮问题" },
      {
        role: "assistant",
        tool_calls: [{
          id: "call_00_abc",
          type: "function",
          function: { name: "bash", arguments: "{\"command\":\"ls\"}" },
        }],
      },
      { role: "tool", tool_call_id: "call_00_abc", content: "file-a\nfile-b" },
      // reasoning 留下的 assistant 消息会承接下一个 function_call，
      // 工具调用与发起消息不拆开，上游看到的历史才是连续的。
      {
        role: "assistant",
        content: "先看目录结构",
        tool_calls: [{
          id: "call_01_def",
          type: "function",
          function: { name: "read", arguments: "{\"file_path\":\"a.ts\"}" },
        }],
      },
      { role: "tool", tool_call_id: "call_01_def", content: "content" },
      { role: "user", content: "继续" },
    ]);
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

  it("normalizes Responses output history for a follow-up request", () => {
    const result = toChatRequestFromResponses({
      model: "deepseek/deepseek-v4-flash",
      input: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I will check that." }],
        },
        {
          type: "function_call",
          call_id: "call_lookup",
          name: "lookup",
          arguments: "{\"id\":\"7\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_lookup",
          output: "{\"name\":\"Ada\"}",
        },
        { type: "input_text", text: "Continue." },
      ],
    });

    expect(result.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "I will check that." }],
        tool_calls: [{
          id: "call_lookup",
          type: "function",
          function: { name: "lookup", arguments: "{\"id\":\"7\"}" },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_lookup",
        content: "{\"name\":\"Ada\"}",
      },
      { role: "user", content: [{ type: "text", text: "Continue." }] },
    ]);

    const commandRequest = toCommandCodeGenerateRequest(result);
    expect(commandRequest.params.messages).toEqual([
      {
        role: "assistant",
        content: [{
          type: "text",
          text: "I will check that.",
        }, {
          type: "tool-call",
          toolCallId: "call_lookup",
          toolName: "lookup",
          input: { id: "7" },
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_lookup",
          toolName: "lookup",
          output: { type: "text", value: "{\"name\":\"Ada\"}" },
        }],
      },
      { role: "user", content: [{ type: "text", text: "Continue." }] },
    ]);
  });

  it("rejects Responses structured output without changing the prompt", () => {
    expect(() => toChatRequestFromResponses({
      model: "deepseek/deepseek-v4-flash",
      input: "Return JSON",
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: { type: "object", properties: { value: { type: "string" } } },
        },
      },
    })).toThrow("Structured output");
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

  it("logs the inbound request when local Responses conversion fails", async () => {
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    const app = buildServer({
      commandCodeClient: fakeClient([]),
      logger: { level: "info", stream: output },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer request-key" },
      payload: {
        model: "deepseek/deepseek-v4-flash",
        input: [{ type: "unsupported_input_item", value: "bad" }],
      },
    });
    await app.close();

    const logs = chunks.join("");
    expect(response.statusCode).toBe(400);
    expect(logs).toContain("CommandCode Responses 入站请求参数");
    expect(logs).toContain("unsupported_input_item");
    expect(logs).toContain("CommandCode Responses 本地处理失败");
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

  it("creates a reasoning item before emitting reasoning deltas", async () => {
    const response = await buildServer({
      commandCodeClient: fakeClient([
        { type: "reasoning-delta", text: "Thinking" },
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

    const added = response.body.indexOf("response.output_item.added");
    const reasoning = response.body.indexOf("response.reasoning_summary_text.delta");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"type":"reasoning"');
    expect(added).toBeLessThan(reasoning);
    expect(response.body).toContain("response.reasoning_summary_text.done");
  });

  it("ignores previous_response_id and forwards the current input", async () => {
    const response = await buildServer({
      commandCodeClient: fakeClient([
        { type: "text-delta", text: "CONTINUED" },
        { type: "finish", finishReason: "end_turn" },
      ]),
    }).inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer request-key" },
      payload: {
        model: "deepseek/deepseek-v4-flash",
        input: "Continue",
        previous_response_id: "resp_previous",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      output: [{ content: [{ text: "CONTINUED" }] }],
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

    // 上游 400 透传为 400：池化网关据此判断是请求问题而非账号故障。
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { type: "invalid_request_error", code: "upstream_invalid_request" },
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
    // 固定 workingDir 与客户端实例同生命周期，不再按请求清理。
    expect(removeTempDir).not.toHaveBeenCalled();
  });
});
