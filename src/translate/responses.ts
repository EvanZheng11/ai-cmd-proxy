import { randomUUID } from "node:crypto";

import { parseResponsesRequest } from "../openai/schemas.js";
import type { ChatCompletionRequest, OpenAiContentPart, ResponsesRequest } from "../openai/types.js";
import type { CommandCodeEvent } from "../commandcode/types.js";
import { eventStatusCode, UpstreamStreamError } from "../errors.js";
import { toCommandCodeGenerateRequest } from "./generate-request.js";

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

function normalizeInput(input: ResponsesRequest["input"]): ChatCompletionRequest["messages"] {
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

  if (Array.isArray(input) && input.every((item) => typeof item === "object" && item !== null && "role" in item)) {
    return (input as Array<Record<string, unknown>>).map((message) => ({
      ...message,
      ...(Array.isArray(message.content)
        ? { content: normalizeParts(message.content, message.role === "assistant") }
        : {}),
    })) as ChatCompletionRequest["messages"];
  }

  const messages: ChatCompletionRequest["messages"] = [];
  const userParts: ReturnType<typeof normalizeParts> = [];
  const flushUserParts = () => {
    if (userParts.length > 0) {
      messages.push({ role: "user", content: [...userParts] as ChatCompletionRequest["messages"][number]["content"] });
      userParts.length = 0;
    }
  };

  for (const item of input as unknown[]) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const value = item as Record<string, unknown>;
    if (value.type === "input_text" || value.type === "input_image") {
      userParts.push(...normalizeParts([value]));
      continue;
    }
    if (value.type === "message") {
      flushUserParts();
      const role = value.role === "user" ? "user" : "assistant";
      const content = Array.isArray(value.content)
        ? normalizeParts(value.content, role === "assistant")
        : typeof value.content === "string" ? value.content : [];
      if (typeof content === "string" || content.length > 0) {
        messages.push({ role, content } as ChatCompletionRequest["messages"][number]);
      }
      continue;
    }
    if (value.type === "function_call") {
      flushUserParts();
      const toolCall = {
          id: String(value.call_id ?? ""),
          type: "function",
          function: {
            name: String(value.name ?? ""),
            arguments: typeof value.arguments === "string"
              ? value.arguments
              : JSON.stringify(value.arguments ?? {}),
          },
        } as const;
      const last = messages.at(-1);
      if (last?.role === "assistant") {
        last.tool_calls = [...(last.tool_calls ?? []), toolCall];
      } else {
        messages.push({ role: "assistant", tool_calls: [toolCall] });
      }
      continue;
    }
    if (value.type === "function_call_output") {
      flushUserParts();
      messages.push({
        role: "tool",
        tool_call_id: String(value.call_id ?? ""),
        content: typeof value.output === "string" ? value.output : JSON.stringify(value.output ?? {}),
      });
    }
  }

  flushUserParts();
  return messages;
}

export function toChatRequestFromResponses(input: unknown): ChatCompletionRequest {
  const request = parseResponsesRequest(input);
  if (request.text?.format !== undefined && request.text.format.type !== "text") {
    throw new Error("Structured output is not supported by the CommandCode upstream");
  }
  return {
    model: request.model,
    messages: [
      ...(request.instructions !== undefined
        ? [{ role: "system" as const, content: request.instructions }]
        : []),
      ...normalizeInput(request.input),
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
          tools: request.tools.map((tool) => "function" in tool
            ? tool
            : {
                type: "function" as const,
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                  strict: tool.strict,
                },
              }),
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

export function toResponse(events: CommandCodeEvent[], model: string) {
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
      name: call.name,
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
      const name = event.toolName ?? "";
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
          name,
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
      yield emit("response.output_item.done", {
        output_index: outputIndex,
        item: {
          id: itemId,
          type: "function_call",
          status: "completed",
          call_id: callId,
          name,
          arguments: args,
        },
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
    output.push(item);
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
    output.push(item);
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
