import { describe, expect, it } from "vitest";

import type { CommandCodeEvent } from "../src/commandcode/types.js";
import { parseChatCompletionRequest } from "../src/openai/schemas.js";
import { toChatCompletion, toChatCompletionChunks } from "../src/translate/chat.js";
import { toCommandCodeGenerateRequest } from "../src/translate/generate-request.js";
import * as responses from "../src/translate/responses.js";

const model = "test-model";
const call: CommandCodeEvent = { type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: { id: 7 } };
const historyCall = { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"id":7}' };
const historyResult = { type: "function_call_output", call_id: "call_1", output: "真实结果" };

async function* stream(events: CommandCodeEvent[]) {
  yield* events;
}

async function frames(events: AsyncIterable<string>) {
  const result = [];
  for await (const frame of events) {
    const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    if (data && data !== "[DONE]") result.push(JSON.parse(data));
  }
  return result;
}

describe("Responses 协议回归", () => {
  it("纯工具流的 completed.output 保留工具且不创建空 assistant", async () => {
    const events = await frames(responses.toResponseEvents(stream([call]), model));
    const added = events.filter((event) => event.type === "response.output_item.added");
    const done = events.filter((event) => event.type === "response.output_item.done");
    const output = events.at(-1).response.output;
    expect(output).toEqual(done.map((event) => event.item));
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ type: "function_call", call_id: "call_1", name: "lookup" });
    expect(added.map((event) => event.item.id)).toEqual(output.map((item: { id: string }) => item.id));
    expect(events.some((event) => event.type === "response.content_part.added")).toBe(false);
  });

  it.each([
    [call, { type: "text-delta", text: "已请求" }, { type: "reasoning-delta", text: "核对" }],
    [{ type: "text-delta", text: "已请求" }, call, { type: "reasoning-delta", text: "核对" }],
    [{ type: "reasoning-delta", text: "核对" }, call, { ...call, toolCallId: "call_2" }],
  ])("混合输出按 output_index 保持顺序和完整项 %#", async (...upstream) => {
    const events = await frames(responses.toResponseEvents(stream(upstream), model));
    const done = events.filter((event) => event.type === "response.output_item.done")
      .sort((a, b) => a.output_index - b.output_index);
    const output = events.at(-1).response.output;
    expect(output).toEqual(done.map((event) => event.item));
    for (const added of events.filter((event) => event.type === "response.output_item.added")) {
      expect(output[added.output_index].id).toBe(added.item.id);
    }
  });

  it.each(["", "正在查询", [], [{ type: "output_text", text: "正在查询" }]].map((content) => ({ content })))(
    "工具调用后的 assistant 内容合并到同轮，不隔断结果：$content", ({ content }) => {
      const chat = responses.toChatRequestFromResponses({ model, input: [historyCall, { role: "assistant", content }, historyResult] });
      const upstream = toCommandCodeGenerateRequest(chat).params.messages;
      expect(upstream.map((message) => message.role)).toEqual(["assistant", "tool"]);
      expect(upstream[0].content).toContainEqual({ type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: { id: 7 } });
      if (typeof content === "string" && content) expect(upstream[0].content).toContainEqual({ type: "text", text: content });
      expect(upstream[1].content).toEqual([{ type: "tool-result", toolCallId: "call_1", toolName: "lookup", output: { type: "text", value: "真实结果" } }]);
    },
  );

  it("混合历史保留 system/developer 角色并完整保留多轮工具结果", () => {
    const chat = responses.toChatRequestFromResponses({ model, input: [
      { role: "system", content: "系统规则" }, { type: "message", role: "developer", content: "开发者规则" },
      historyCall, historyResult, { role: "user", content: "继续" },
      { ...historyCall, call_id: "call_2" }, { ...historyResult, call_id: "call_2", output: "第二次结果" },
    ] });
    expect(chat.messages.slice(0, 2).map((message) => message.role)).toEqual(["system", "developer"]);
    const upstream = toCommandCodeGenerateRequest(chat).params;
    expect(upstream.system).toBe("系统规则\n\n开发者规则");
    expect(upstream.messages.map((message) => message.role)).toEqual(["assistant", "tool", "user", "assistant", "tool"]);
    expect(upstream.messages[4].content[0]).toMatchObject({ toolCallId: "call_2", output: { value: "第二次结果" } });
  });

  it("Responses reasoning summary 往返后是原生 reasoning 块", () => {
    const response = responses.toResponse([{ type: "reasoning-delta", text: "先核对" }, call], model);
    const upstream = responses.toCommandCodeResponsesRequest({ model, input: [...response.output, { role: "assistant", content: "" }, historyResult] });
    expect(upstream.params.messages.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(upstream.params.messages[0].content).toEqual([
      { type: "reasoning", text: "先核对" },
      { type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: { id: 7 } },
    ]);
  });

  it("namespace 工具名稳定唯一，历史、非流式和流式输出均可还原", async () => {
    const tools = [
      { type: "namespace", name: "first", tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] },
      { type: "namespace", name: "second", tools: [{ type: "function", name: "lookup" }] },
      { type: "function", name: "first_lookup" },
    ];
    const chat = responses.toChatRequestFromResponses({ model, tools, input: [
      { ...historyCall, namespace: "first" }, historyResult,
    ] });
    const names = chat.tools!.map((tool) => tool.function.name);
    expect(new Set(names).size).toBe(3);
    expect(names.every((name) => /^[a-zA-Z0-9_-]{1,64}$/.test(name))).toBe(true);
    expect(chat.messages[0].tool_calls![0].function.name).toBe(names[0]);
    const options = { toolNameMap: responses.buildResponsesToolNameMap(tools) };
    const upstreamCall = { ...call, toolName: names[0] };
    const output = responses.toResponse([upstreamCall], model, options).output;
    expect(output[0]).toMatchObject({ name: "lookup", namespace: "first", call_id: "call_1" });
    const events = await frames(responses.toResponseEvents(stream([upstreamCall]), model, options));
    for (const event of events.filter((event) => event.item)) {
      expect(event.item).toMatchObject({ name: "lookup", namespace: "first" });
    }
    expect(events.at(-1).response.output[0]).toMatchObject({ name: "lookup", namespace: "first" });
    const roundTrip = responses.toCommandCodeResponsesRequest({ model, tools, input: [...output, historyResult] });
    expect(roundTrip.params.messages[1].content[0]).toMatchObject({ toolName: names[0], output: { value: "真实结果" } });
    expect(responses.toChatRequestFromResponses({ model, input: "继续", tools: [...tools].reverse() }).tools!.map((tool) => tool.function.name)).toEqual([...names].reverse());
  });

  it("namespace 别名和用户平铺函数发生碰撞时仍唯一且确定", () => {
    const namespaced = { type: "namespace", name: "a_b", tools: [{ type: "function", name: "c" }] };
    const base = responses.toChatRequestFromResponses({ model, input: "调用", tools: [namespaced] }).tools![0].function.name;
    const tools = [namespaced, { type: "namespace", name: "a", tools: [{ type: "function", name: "b_c" }] }, { type: "function", name: base }];
    const names = responses.toChatRequestFromResponses({ model, input: "调用", tools }).tools!.map((tool) => tool.function.name);
    expect(new Set(names).size).toBe(3);
    expect(names[2]).toBe(base);
    expect(responses.toChatRequestFromResponses({ model, input: "调用", tools: [...tools].reverse() }).tools!.map((tool) => tool.function.name)).toEqual([...names].reverse());
  });

  it.each(["web_search", "image_generation", "custom"])("明确拒绝不支持工具 %s 并提供具体字段", (type) => {
    expect(() => responses.toChatRequestFromResponses({ model, input: "调用", tools: [{ type, name: "bad" }] })).toThrowError(expect.objectContaining({
      name: "ResponsesTranslationError", code: "unsupported_tool_type", param: "tools[0].type", statusCode: 400,
    }));
  });

  it("嵌套的不支持工具也给出具体字段", () => {
    expect(() => responses.toChatRequestFromResponses({ model, input: "调用", tools: [{ type: "namespace", name: "ns", tools: [{ type: "custom", name: "bad" }] }] })).toThrowError(expect.objectContaining({
      code: "unsupported_tool_type", param: "tools[0].tools[0].type",
    }));
  });

  it("重复的同名 namespace 函数明确报错，不覆盖映射", () => {
    expect(() => responses.toChatRequestFromResponses({ model, input: "调用", tools: [{ type: "namespace", name: "ns", tools: [
      { type: "function", name: "lookup" }, { type: "function", name: "lookup" },
    ] }] })).toThrowError(expect.objectContaining({ code: "duplicate_tool_name", param: "tools[0].tools[1].name" }));
  });

  it("不能丢弃不支持的工具结果条目", () => {
    expect(() => responses.toChatRequestFromResponses({ model, input: [historyCall, { type: "custom_tool_call_output", call_id: "call_1", output: "结果" }] })).toThrowError(expect.objectContaining({
      code: "unsupported_input_item", param: "input[1].type",
    }));
  });

  it.each([
    { input: [historyCall, { type: "function_call_output", call_id: "call_1" }], param: "input[1].output" },
    { input: [historyCall, { ...historyResult, call_id: "" }], param: "input[1].call_id" },
    { input: [{ ...historyCall, call_id: "" }], param: "input[0].call_id" },
    { input: [{ ...historyCall, name: "" }], param: "input[0].name" },
    { input: [{ ...historyCall, arguments: undefined }], param: "input[0].arguments" },
  ])("缺失工具字段 $param 明确报错而不伪造", ({ input, param }) => {
    expect(() => responses.toChatRequestFromResponses({ model, input })).toThrowError(expect.objectContaining({ code: "invalid_tool_history", param }));
  });

  it("无对应工具定义的 namespace 历史明确报错", () => {
    expect(() => responses.toChatRequestFromResponses({ model, input: [{ ...historyCall, namespace: "missing" }, historyResult] })).toThrowError(expect.objectContaining({ code: "unknown_tool_name", param: "input[0].name" }));
  });
});

describe("Chat reasoning 协议回归", () => {
  it("reasoning_content 经 schema 和转换后保留原生类型", () => {
    const input = { model, messages: [{ role: "assistant", content: "答复", reasoning_content: "推理过程" }] };
    expect(parseChatCompletionRequest(input).messages[0]).toHaveProperty("reasoning_content", "推理过程");
    expect(toCommandCodeGenerateRequest(input).params.messages[0].content).toEqual([
      { type: "reasoning", text: "推理过程" }, { type: "text", text: "答复" },
    ]);
  });

  it("Chat 非流式输出独立 reasoning_content", () => {
    const response = toChatCompletion([{ type: "reasoning-delta", text: "推理" }, { type: "reasoning-delta", text: "过程" }, { type: "text-delta", text: "答复" }], { model });
    expect(response.choices[0].message).toMatchObject({ content: "答复", reasoning_content: "推理过程" });
  });

  it("Chat 流式输出独立 reasoning_content delta", async () => {
    const events = await frames(toChatCompletionChunks(stream([{ type: "reasoning-delta", text: "推理" }, { type: "text-delta", text: "答复" }]), { model }));
    expect(events.map((event) => event.choices[0].delta)).toEqual([{ role: "assistant" }, { reasoning_content: "推理" }, { content: "答复" }]);
  });
});
