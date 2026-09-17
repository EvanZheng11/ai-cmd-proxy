import { createHash, randomUUID } from "node:crypto";

import { parseResponsesRequest, parseResponsesTools, ResponsesTranslationError } from "../openai/schemas.js";
import type { ChatCompletionRequest, OpenAiChatMessage, OpenAiContentPart, OpenAiTool, ResponsesRequest } from "../openai/types.js";
import type { CommandCodeEvent } from "../commandcode/types.js";
import { eventStatusCode, UpstreamStreamError } from "../errors.js";
import { toCommandCodeGenerateRequest } from "./generate-request.js";

export { ResponsesTranslationError } from "../openai/schemas.js";

export type ResponsesToolNameMap = ReadonlyMap<string, { name: string; namespace?: string }>;
export type ResponsesOutputOptions = { toolNameMap?: ResponsesToolNameMap };

function flattenTools(tools: ResponsesRequest["tools"] = []) {
  return tools.flatMap<{ fn: OpenAiTool["function"]; namespace: string | undefined; param: string }>((tool, index) => {
    if (tool.type === "namespace") {
      return tool.tools.map((child, childIndex) => ({
        fn: "function" in child ? child.function : child,
        namespace: tool.name,
        param: `tools[${index}].tools[${childIndex}].${"function" in child ? "function." : ""}name`,
      }));
    }
    return [{
      fn: "function" in tool ? tool.function : tool,
      namespace: undefined,
      param: `tools[${index}].${"function" in tool ? "function." : ""}name`,
    }];
  });
}

// 请求级映射由路由传给输出转换器；相同工具集合与输入顺序无关。
export function buildResponsesToolNameMap(tools: unknown = []): ResponsesToolNameMap {
  const entries = flattenTools(parseResponsesTools(tools));
  const identities = new Set<string>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.namespace, entry.fn.name]);
    if (identities.has(key)) {
      throw new ResponsesTranslationError("工具名称重复", entry.param, "duplicate_tool_name");
    }
    identities.add(key);
  }
  const map = new Map<string, { name: string; namespace?: string }>();
  for (const { fn, namespace } of entries) {
    if (namespace === undefined) map.set(fn.name, { name: fn.name });
  }
  const namespaced = entries.filter((entry) => entry.namespace !== undefined)
    .sort((a, b) => JSON.stringify([a.namespace, a.fn.name]).localeCompare(JSON.stringify([b.namespace, b.fn.name])));
  for (const { fn, namespace } of namespaced) {
    const base = `ns_${createHash("sha256").update(JSON.stringify([namespace, fn.name])).digest("hex").slice(0, 48)}`;
    let name = base;
    for (let suffix = 1; map.has(name); suffix++) name = `${base}_${suffix}`;
    map.set(name, { name: fn.name, namespace });
  }
  return map;
}

function upstreamToolName(name: string, namespace: string | undefined, map: ResponsesToolNameMap, param: string): string {
  for (const [alias, original] of map) {
    if (original.name === name && original.namespace === namespace) return alias;
  }
  if (namespace !== undefined) {
    throw new ResponsesTranslationError("找不到 namespace 函数定义", param, "unknown_tool_name");
  }
  return name;
}

type ResponseState = {
  text: string;
  reasoning: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  finishReason: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    // 下游（sub2api 等）从 input_tokens_details.cached_tokens 读取缓存命中量。
    input_tokens_details: {
      cached_tokens: number;
    };
  };
};

export class UnsupportedImageFileIdError extends Error {
  constructor() {
    super("OpenAI image file_id is not supported; use image_url instead");
    this.name = "UnsupportedImageFileIdError";
  }
}

function normalizeInput(input: ResponsesRequest["input"], toolNameMap: ResponsesToolNameMap): ChatCompletionRequest["messages"] {
  const normalizeParts = (parts: unknown[], output = false): OpenAiContentPart[] => parts.flatMap<OpenAiContentPart>((part) => {
    if (!part || typeof part !== "object") {
      return [];
    }
    const value = part as Record<string, unknown>;
    if ((value.type === "text" || value.type === "input_text" || (output && value.type === "output_text"))
      && typeof value.text === "string") {
      return [{ type: "text" as const, text: value.text }];
    }
    if (value.type === "input_image" || value.type === "image_url") {
      if (typeof value.file_id === "string" && value.file_id) {
        throw new UnsupportedImageFileIdError();
      }
      const imageUrl = typeof value.image_url === "string"
        ? value.image_url
        : value.image_url && typeof value.image_url === "object"
          ? String((value.image_url as Record<string, unknown>).url ?? "")
          : "";
      if (!imageUrl) {
        return [];
      }
      return [{ type: "image_url" as const, image_url: { url: imageUrl } }];
    }
    return [];
  });

  if (typeof input === "string") {
    return [{ role: "user" as const, content: input }];
  }

  // Responses API 允许输入数组里直接混入不带 role 的简写条目
  // （function_call / function_call_output / reasoning 等）。只按 role 分流的
  // 实现会把它们整体丢弃，多轮工具调用会丢失全部历史，这里统一转换。
  const messages: ChatCompletionRequest["messages"] = [];
  const appendMessage = (message: OpenAiChatMessage) => {
    const last = messages.at(-1);
    if (last?.role !== "assistant" || message.role !== "assistant") {
      messages.push(message);
      return;
    }
    // 同一轮 Responses 可以把推理、正文和工具分为多个条目；工具结果前不能插入新 assistant。
    if (message.content) {
      if (!last.content || last.content.length === 0) last.content = message.content;
      else if (typeof last.content === "string" && typeof message.content === "string") last.content += message.content;
      else {
        const parts = (content: NonNullable<OpenAiChatMessage["content"]>): OpenAiContentPart[] =>
          typeof content === "string" ? [{ type: "text", text: content }] : content;
        last.content = [...parts(last.content), ...parts(message.content)];
      }
    }
    if (message.reasoning_content) last.reasoning_content = (last.reasoning_content ?? "") + message.reasoning_content;
    if (message.tool_calls) last.tool_calls = [...(last.tool_calls ?? []), ...message.tool_calls];
  };
  const userParts: ReturnType<typeof normalizeParts> = [];
  const flushUserParts = () => {
    if (userParts.length > 0) {
      messages.push({ role: "user", content: [...userParts] as ChatCompletionRequest["messages"][number]["content"] });
      userParts.length = 0;
    }
  };

  // Responses API 的输入数组允许三种条目混用：带 role 的 message、
  // 不带 role 的简写条目（function_call / function_call_output / reasoning），
  // 以及不带 role 的 message（如 {"role":"user","content":"..."}）。
  // 只认 type === "message" 会把真实客户端（如 DeepSeek Harness）回传的
  // 全部历史丢弃，这里按「有无 role」分流而不是按 type 分流。
  for (const [index, item] of (input as unknown[]).entries()) {
    const param = `input[${index}]`;
    if (!item || typeof item !== "object") {
      throw new ResponsesTranslationError("输入条目必须是对象", param, "unsupported_input_item");
    }
    const value = item as Record<string, unknown>;
    if (value.type === "input_text" || value.type === "input_image") {
      userParts.push(...normalizeParts([value]));
      continue;
    }
    const hasRole = typeof value.role === "string" && value.role.length > 0;
    if (value.type === "message" || (hasRole && !value.type)) {
      flushUserParts();
      const role = value.role as OpenAiChatMessage["role"];
      if (!["user", "assistant", "system", "developer", "tool"].includes(role)) {
        throw new ResponsesTranslationError("不支持的消息角色", `${param}.role`, "unsupported_input_item");
      }
      const content = Array.isArray(value.content)
        ? normalizeParts(value.content, role === "assistant")
        : typeof value.content === "string" ? value.content : [];
      const { type: _type, id: _id, status: _status, ...message } = value;
      appendMessage({ ...message, role, content } as OpenAiChatMessage);
      continue;
    }
    if (value.type === "reasoning") {
      flushUserParts();
      const summaryText = Array.isArray(value.summary)
        ? (value.summary as Array<Record<string, unknown>>)
            .map((part) => typeof part?.text === "string" ? part.text : "")
            .join("")
        : "";
      if (summaryText) {
        appendMessage({ role: "assistant", reasoning_content: summaryText });
      }
      continue;
    }
    if (value.type === "function_call" || value.type === "function_call_output") {
      const stringFields = value.type === "function_call" ? ["call_id", "name"] : ["call_id"];
      for (const field of stringFields) {
        if (typeof value[field] !== "string" || !value[field]) {
          throw new ResponsesTranslationError("工具历史字段必须是非空字符串", `${param}.${field}`, "invalid_tool_history");
        }
      }
      const payload = value.type === "function_call" ? "arguments" : "output";
      if (value[payload] === undefined) {
        throw new ResponsesTranslationError("缺少工具历史字段", `${param}.${payload}`, "invalid_tool_history");
      }
    }
    if (value.type === "function_call") {
      flushUserParts();
      const toolCall = {
          id: String(value.call_id ?? ""),
          type: "function",
          function: {
            name: upstreamToolName(String(value.name ?? ""), typeof value.namespace === "string" ? value.namespace : undefined, toolNameMap, `${param}.name`),
            arguments: typeof value.arguments === "string"
              ? value.arguments
              : JSON.stringify(value.arguments ?? {}),
          },
        } as const;
      appendMessage({ role: "assistant", tool_calls: [toolCall] });
      continue;
    }
    if (value.type === "function_call_output") {
      flushUserParts();
      messages.push({
        role: "tool",
        tool_call_id: String(value.call_id ?? ""),
        content: typeof value.output === "string" ? value.output : JSON.stringify(value.output),
      });
      continue;
    }
    throw new ResponsesTranslationError(`不支持输入条目类型 ${String(value.type)}`, `${param}.type`, "unsupported_input_item");
  }

  flushUserParts();
  return messages;
}

export function toChatRequestFromResponses(input: unknown): ChatCompletionRequest {
  const request = parseResponsesRequest(input);
  const toolNameMap = buildResponsesToolNameMap(request.tools);
  if (request.text?.format !== undefined && request.text.format.type !== "text") {
    throw new Error("Structured output is not supported by the CommandCode upstream");
  }
  return {
    model: request.model,
    messages: [
      ...(request.instructions !== undefined
        ? [{ role: "system" as const, content: request.instructions }]
        : []),
      ...normalizeInput(request.input, toolNameMap),
    ],
    ...(request.stream === undefined ? {} : { stream: request.stream }),
    ...(request.max_output_tokens === undefined
      ? {}
      : { max_completion_tokens: request.max_output_tokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.top_p === undefined ? {} : { top_p: request.top_p }),
    ...(request.reasoning?.effort === undefined
      ? {}
      : { reasoning_effort: request.reasoning.effort }),
    ...(request.tools === undefined
      ? {}
      : {
          tools: flattenTools(request.tools).map(({ fn, namespace, param }): OpenAiTool => ({
            type: "function",
            function: {
              name: upstreamToolName(fn.name, namespace, toolNameMap, param),
              description: fn.description,
              parameters: fn.parameters,
              strict: fn.strict,
            },
          })),
        }),
  };
}

export function toCommandCodeResponsesRequest(
  input: unknown,
  options: { defaultMaxTokens?: number } = {},
) {
  return toCommandCodeGenerateRequest(toChatRequestFromResponses(input), options);
}

function usageFromEvent(event: CommandCodeEvent) {
  const usage = event.totalUsage;
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  if (input === undefined && output === undefined) {
    return undefined;
  }
  // input_tokens 已包含命中缓存的 token，cached 只作为明细回传。
  return {
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    total_tokens: (input ?? 0) + (output ?? 0),
    input_tokens_details: {
      cached_tokens: usage?.cachedInputTokens
        ?? usage?.inputTokenDetails?.cacheReadTokens
        ?? 0,
    },
  };
}

function collectState(events: CommandCodeEvent[]): ResponseState {
  const state: ResponseState = {
    text: "",
    reasoning: "",
    toolCalls: [],
    finishReason: "stop",
  };
  for (const event of events) {
    if (event.type === "error" || event.type === "abort") {
      const message = typeof event.error === "string"
        ? event.error
        : event.error?.message ?? "CommandCode stream aborted";
      throw new UpstreamStreamError(message, eventStatusCode(event));
    } else if (event.type === "text-delta") {
      state.text += event.text ?? "";
    } else if (event.type === "reasoning-delta") {
      state.reasoning += event.text ?? "";
    } else if (event.type === "tool-call") {
      state.toolCalls.push({
        id: event.toolCallId ?? `call_${randomUUID()}`,
        name: event.toolName ?? "",
        arguments: typeof event.input === "string"
          ? event.input
          : JSON.stringify(event.input ?? event.args ?? {}),
      });
    } else if (event.type === "finish") {
      state.finishReason = event.finishReason ?? "stop";
      state.usage = usageFromEvent(event);
    }
  }
  return state;
}

function responseSkeleton(id: string, model: string) {
  return {
    id,
    object: "response" as const,
    created_at: Math.floor(Date.now() / 1000),
    status: "completed" as const,
    model,
  };
}

export function toResponse(events: CommandCodeEvent[], model: string, options: ResponsesOutputOptions = {}) {
  const id = `resp_${randomUUID()}`;
  const state = collectState(events);
  const response = responseSkeleton(id, model);
  const output = [];
  if (state.reasoning) {
    output.push({
      id: `rs_${randomUUID()}`,
      type: "reasoning" as const,
      status: "completed" as const,
      summary: [{ type: "summary_text", text: state.reasoning }],
    });
  }
  if (state.text || state.toolCalls.length === 0) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: "message" as const,
      status: "completed" as const,
      role: "assistant" as const,
      content: [{
        type: "output_text" as const,
        text: state.text,
        annotations: [],
      }],
    });
  }
  for (const call of state.toolCalls) {
    output.push({
      id: `fc_${randomUUID()}`,
      type: "function_call" as const,
      status: "completed" as const,
      call_id: call.id,
      ...(options.toolNameMap?.get(call.name) ?? { name: call.name }),
      arguments: call.arguments,
    });
  }

  return {
    ...response,
    output,
    ...(state.usage ? { usage: state.usage } : {}),
  };
}

export async function* toResponseEvents(
  events: AsyncIterable<CommandCodeEvent>,
  model: string,
  options: ResponsesOutputOptions = {},
): AsyncIterable<string> {
  const id = `resp_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let text = "";
  let reasoning = "";
  let usage: ResponseState["usage"];
  let nextOutputIndex = 0;
  let messageId: string | undefined;
  let messageOutputIndex: number | undefined;
  let reasoningId: string | undefined;
  let reasoningOutputIndex: number | undefined;
  const output: Array<Record<string, unknown>> = [];

  const response = {
    ...responseSkeleton(id, model),
    status: "in_progress",
    output: [],
  };
  const emit = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const addMessage = () => {
    if (messageId) {
      return [];
    }
    messageId = `msg_${randomUUID()}`;
    messageOutputIndex = nextOutputIndex++;
    return [
      emit("response.output_item.added", {
        output_index: messageOutputIndex,
        item: {
          id: messageId,
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [],
        },
      }),
      emit("response.content_part.added", {
        item_id: messageId,
        output_index: messageOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }),
    ];
  };
  const addReasoning = () => {
    if (reasoningId) {
      return [];
    }
    reasoningId = `rs_${randomUUID()}`;
    reasoningOutputIndex = nextOutputIndex++;
    return [
      emit("response.output_item.added", {
        output_index: reasoningOutputIndex,
        item: {
          id: reasoningId,
          type: "reasoning",
          status: "in_progress",
          summary: [],
        },
      }),
      emit("response.reasoning_summary_part.added", {
        item_id: reasoningId,
        output_index: reasoningOutputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      }),
    ];
  };

  yield emit("response.created", { response });

  for await (const event of events) {
    if (event.type === "error" || event.type === "abort") {
      const message = typeof event.error === "string"
        ? event.error
        : event.error?.message ?? "CommandCode stream aborted";
      throw new UpstreamStreamError(message, eventStatusCode(event));
    } else if (event.type === "text-delta" && event.text) {
      for (const chunk of addMessage()) {
        yield chunk;
      }
      text += event.text;
      yield emit("response.output_text.delta", {
        item_id: messageId!,
        output_index: messageOutputIndex!,
        content_index: 0,
        delta: event.text,
      });
    } else if (event.type === "reasoning-delta" && event.text) {
      for (const chunk of addReasoning()) {
        yield chunk;
      }
      reasoning += event.text;
      yield emit("response.reasoning_summary_text.delta", {
        item_id: reasoningId!,
        output_index: reasoningOutputIndex!,
        summary_index: 0,
        delta: event.text,
      });
    } else if (event.type === "tool-call") {
      const callId = event.toolCallId ?? `call_${randomUUID()}`;
      const original = options.toolNameMap?.get(event.toolName ?? "") ?? { name: event.toolName ?? "" };
      const args = typeof event.input === "string"
        ? event.input
        : JSON.stringify(event.input ?? event.args ?? {});
      const outputIndex = nextOutputIndex++;
      const itemId = `fc_${randomUUID()}`;
      yield emit("response.output_item.added", {
        output_index: outputIndex,
        item: {
          id: itemId,
          type: "function_call",
          status: "in_progress",
          call_id: callId,
          ...original,
          arguments: "",
        },
      });
      yield emit("response.function_call_arguments.delta", {
        item_id: itemId,
        output_index: outputIndex,
        delta: args,
      });
      yield emit("response.function_call_arguments.done", {
        item_id: itemId,
        output_index: outputIndex,
        arguments: args,
      });
      const item = {
        id: itemId,
        type: "function_call",
        status: "completed",
        call_id: callId,
        ...original,
        arguments: args,
      };
      output[outputIndex] = item;
      yield emit("response.output_item.done", {
        output_index: outputIndex,
        item,
      });
    } else if (event.type === "finish") {
      usage = usageFromEvent(event);
    }
  }

  if (reasoningId) {
    const item = {
      id: reasoningId,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoning }],
    };
    yield emit("response.reasoning_summary_text.done", {
      item_id: reasoningId,
      output_index: reasoningOutputIndex!,
      summary_index: 0,
      text: reasoning,
    });
    yield emit("response.reasoning_summary_part.done", {
      item_id: reasoningId,
      output_index: reasoningOutputIndex!,
      summary_index: 0,
      part: item.summary[0],
    });
    yield emit("response.output_item.done", {
      output_index: reasoningOutputIndex!,
      item,
    });
    output[reasoningOutputIndex!] = item;
  }
  if (!messageId && output.length === 0) {
    for (const chunk of addMessage()) {
      yield chunk;
    }
  }
  if (messageId) {
    const item = {
      id: messageId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    yield emit("response.output_text.done", {
      item_id: messageId,
      output_index: messageOutputIndex!,
      content_index: 0,
      text,
    });
    yield emit("response.content_part.done", {
      item_id: messageId,
      output_index: messageOutputIndex!,
      content_index: 0,
      part: item.content[0],
    });
    yield emit("response.output_item.done", {
      output_index: messageOutputIndex!,
      item,
    });
    output[messageOutputIndex!] = item;
  }
  yield emit("response.completed", {
    response: {
      ...responseSkeleton(id, model),
      status: "completed",
      output,
      ...(usage ? { usage } : {}),
    },
  });
}
