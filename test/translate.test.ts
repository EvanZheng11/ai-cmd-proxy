import { describe, expect, it, vi } from "vitest";

import { toCommandCodeGenerateRequest } from "../src/translate/generate-request.js";
import { materializeRemoteImages } from "../src/translate/messages.js";

describe("OpenAI request translation", () => {
  it("maps text, system instructions, and max completion tokens", () => {
    const result = toCommandCodeGenerateRequest({
      model: "deepseek/deepseek-v4-flash",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" },
      ],
      max_completion_tokens: 123,
    });

    expect(result.mode).toBe("agent");
    expect(result.params.system).toBe("Be concise.");
    expect(result.params.max_tokens).toBe(123);
    expect(result.params.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);
  });

  it("does not inject proxy instructions into the system prompt", () => {
    expect(() => toCommandCodeGenerateRequest({
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "Return JSON" }],
      response_format: { type: "json_object" },
    })).toThrow("Structured output");
  });

  it("preserves empty system and developer message boundaries", () => {
    const result = toCommandCodeGenerateRequest({
      model: "deepseek/deepseek-v4-flash",
      messages: [
        { role: "system", content: "first" },
        { role: "developer", content: "" },
        { role: "system", content: "second" },
        { role: "user", content: "hello" },
      ],
    });

    expect(result.params.system).toBe("first\n\n\n\nsecond");
  });

  it("maps image data URLs and function tools", () => {
    const result = toCommandCodeGenerateRequest({
      model: "deepseek/deepseek-v4-flash",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Read this" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aGVsbG8=" },
          },
        ],
      }],
      tools: [{
        type: "function",
        function: {
          name: "lookup",
          description: "Find a record",
          parameters: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      }],
    });

    expect(result.params.messages[0]?.content[1]).toMatchObject({
      type: "image",
      image: "data:image/png;base64,aGVsbG8=",
      mediaType: "image/png",
    });
    expect(result.mode).toBe("agent");
    expect(result.params.tools[0]).toEqual({
      name: "lookup",
      description: "Find a record",
      input_schema: {
        type: "object",
        properties: { id: { type: "string" } },
      },
    });
  });

  it("maps sampling and reasoning controls", () => {
    const result = toCommandCodeGenerateRequest({
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "Think" }],
      max_tokens: 12,
      temperature: 0.2,
      top_p: 0.8,
      stop: ["END"],
      reasoning_effort: "high",
    });

    expect(result.params).toMatchObject({
      max_tokens: 12,
      temperature: 0.2,
      top_p: 0.8,
      stop: ["END"],
      reasoning_effort: "high",
    });
  });

  it("uses the configured default token cap when callers omit a limit", () => {
    const result = toCommandCodeGenerateRequest({
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "Default limit" }],
    }, { defaultMaxTokens: 777 });

    expect(result.params.max_tokens).toBe(777);
  });

  it("translates tool selection controls into upstream object form", () => {
    const request = {
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "Use tools" }],
      tools: [{
        type: "function",
        function: { name: "lookup", parameters: { type: "object" } },
      }],
    };

    // 上游只接受对象形式；字符串形式会被上游 zod 校验拒绝。
    expect(toCommandCodeGenerateRequest({ ...request, tool_choice: "required" })
      .params.tool_choice).toEqual({ type: "required" });
    expect(toCommandCodeGenerateRequest({ ...request, tool_choice: "auto" })
      .params.tool_choice).toEqual({ type: "auto" });
    expect(toCommandCodeGenerateRequest({ ...request, tool_choice: "none" })
      .params.tool_choice).toEqual({ type: "none" });
    expect(toCommandCodeGenerateRequest({
      ...request,
      tool_choice: { type: "function", function: { name: "lookup" } },
    }).params.tool_choice).toEqual({ type: "tool", name: "lookup" });
    // 未指定时不注入该字段。
    expect(toCommandCodeGenerateRequest(request).params.tool_choice).toBeUndefined();
  });

  it("ignores parallel_tool_calls instead of failing the request", () => {
    // OpenCode 等 agent 会带这个字段；上游没有对应能力，忽略即可。
    const result = toCommandCodeGenerateRequest({
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "Use tools" }],
      parallel_tool_calls: true,
    });
    expect(result.params.parallel_tool_calls).toBeUndefined();
  });

  it("preserves assistant tool calls and tool results", () => {
    const result = toCommandCodeGenerateRequest({
      model: "deepseek/deepseek-v4-flash",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "{\"id\":\"7\"}" },
          }],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "record found",
        },
      ],
    });

    expect(result.params.messages).toEqual([
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "lookup",
          input: { id: "7" },
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "lookup",
          output: { type: "text", value: "record found" },
        }],
      },
    ]);
  });

  it("materializes a public image URL as a base64 data URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const result = await materializeRemoteImages({
      model: "deepseek/deepseek-v4-flash",
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
      }],
    }, fetchMock, {
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(result.messages[0]?.content).toEqual([{
      type: "image_url",
      image_url: { url: "data:image/png;base64,AQID" },
    }]);
  });

  it("rejects private IPv6 and DNS-resolved private image targets", async () => {
    const fetchMock = vi.fn();
    await expect(materializeRemoteImages({
      model: "deepseek/deepseek-v4-flash",
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://[fd00::1]/a.png" } }],
      }],
    }, fetchMock)).rejects.toThrow("public HTTP(S)");

    await expect(materializeRemoteImages({
      model: "deepseek/deepseek-v4-flash",
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
      }],
    }, fetchMock, {
      resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
    })).rejects.toThrow("public HTTP(S)");
  });

  it("rejects image responses over the configured byte limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": "4",
        },
      }),
    );

    await expect(materializeRemoteImages({
      model: "deepseek/deepseek-v4-flash",
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
      }],
    }, fetchMock, { maxBytes: 3, resolveHost: async () => [{ address: "93.184.216.34", family: 4 }] }))
      .rejects.toThrow("too large");
  });
});
