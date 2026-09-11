import { randomUUID } from "node:crypto";

import type { ChatCompletionRequest } from "../openai/types.js";
import type { CommandCodeEvent, CommandCodeUsage } from "../commandcode/types.js";
import { eventStatusCode, UpstreamStreamError } from "../errors.js";

type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  // sub2api 等下游从 prompt_tokens_details.cached_tokens 读取缓存命中量；
  // 缺少该字段时缓存率会被统计成 0（上游实际命中率可达 90%+）。
  prompt_tokens_details: {
    cached_tokens: number;
  };
};

type ChatState = {
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  finishReason: "stop" | "length" | "tool_calls";
  usage?: Usage;
};

// 上游可能把缓存命中量放在 cachedInputTokens 或 inputTokenDetails.cacheReadTokens，
// 且某些供应商两者都没给——缺失时按 0 处理。
function cacheReadTokens(usage: CommandCodeUsage | undefined): number {
  if (!usage) {
    return 0;
  }
  return usage.cachedInputTokens
    ?? usage.inputTokenDetails?.cacheReadTokens
    ?? 0;
}

function usageFromEvent(event: CommandCodeEvent): Usage | undefined {
  const usage = event.totalUsage;
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  if (input === undefined && output === undefined) {
    return undefined;
  }

  // inputTokens 已包含命中缓存的 token，因此这里不再叠加 cached。
  const promptTokens = input ?? 0;
  const completionTokens = output ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens: cacheReadTokens(usage),
    },
  };
}

function finishReasonFromEvent(event: CommandCodeEvent, hasToolCalls: boolean): ChatState["finishReason"] {
  if (hasToolCalls || event.finishReason === "tool-calls" || event.finishReason === "tool_calls") {
    return "tool_calls";
  }
  return event.finishReason === "length" || event.finishReason === "max_tokens" ? "length" : "stop";
}

export function aggregateChatEvents(events: CommandCodeEvent[]): ChatState {
  const state: ChatState = {
    text: "",
    toolCalls: [],
    finishReason: "stop",
  };

  for (const event of events) {
    if (event.type === "error" || event.type === "abort") {
      // 上游把限流/套餐等真实原因放在 error.message 里，透传 avoid 丢失上下文。
      const message = typeof event.error === "string"
        ? event.error
        : event.error?.message ?? "CommandCode stream aborted";
      throw new UpstreamStreamError(message, eventStatusCode(event));
    } else if (event.type === "text-delta") {
      state.text += event.text ?? "";
    } else if (event.type === "tool-call") {
      state.toolCalls.push({
        id: event.toolCallId ?? `call_${randomUUID()}`,
        name: event.toolName ?? "",
        arguments: typeof event.input === "string"
          ? event.input
          : JSON.stringify(event.input ?? event.args ?? {}),
      });
    } else if (event.type === "finish") {
      state.finishReason = finishReasonFromEvent(event, state.toolCalls.length > 0);
      state.usage = usageFromEvent(event);
    } else if (event.totalUsage) {
      state.usage = usageFromEvent(event);
    }
  }

  if (state.toolCalls.length > 0 && state.finishReason === "stop") {
    state.finishReason = "tool_calls";
  }

  return state;
}

export function toChatCompletion(
  events: CommandCodeEvent[],
  request: Pick<ChatCompletionRequest, "model">,
) {
  const state = aggregateChatEvents(events);
  const message = {
    role: "assistant" as const,
    content: state.text || null,
    ...(state.toolCalls.length > 0
      ? {
          tool_calls: state.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: {
              name: call.name,
              arguments: call.arguments,
            },
          })),
        }
      : {}),
  };

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion" as const,
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [{
      index: 0,
      message,
      finish_reason: state.finishReason,
    }],
    ...(state.usage ? { usage: state.usage } : {}),
  };
}

export async function* toChatCompletionChunks(
  events: AsyncIterable<CommandCodeEvent>,
  request: Pick<ChatCompletionRequest, "model" | "stream_options">,
): AsyncIterable<string> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let sawContent = false;
  let sawToolCall = false;
  let toolIndex = 0;
  let usage: Usage | undefined;

  const emit = (chunk: Record<string, unknown>) => `data: ${JSON.stringify(chunk)}\n\n`;
  yield emit({
    id,
    object: "chat.completion.chunk",
    created,
    model: request.model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });

  for await (const event of events) {
    if (event.type === "error" || event.type === "abort") {
      // 上游把限流/套餐等真实原因放在 error.message 里，透传 avoid 丢失上下文。
      const message = typeof event.error === "string"
        ? event.error
        : event.error?.message ?? "CommandCode stream aborted";
      throw new UpstreamStreamError(message, eventStatusCode(event));
    } else if (event.type === "text-delta" && event.text) {
      sawContent = true;
      yield emit({
        id,
        object: "chat.completion.chunk",
        created,
        model: request.model,
        choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
      });
    } else if (event.type === "tool-call") {
      sawToolCall = true;
      yield emit({
        id,
        object: "chat.completion.chunk",
        created,
        model: request.model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: toolIndex++,
              id: event.toolCallId ?? `call_${randomUUID()}`,
              type: "function",
              function: {
                name: event.toolName ?? "",
                arguments: typeof event.input === "string"
                  ? event.input
                  : JSON.stringify(event.input ?? event.args ?? {}),
              },
            }],
          },
          finish_reason: null,
        }],
      });
    } else if (event.type === "finish") {
      usage = usageFromEvent(event);
      const finishReason = finishReasonFromEvent(event, sawToolCall);
      yield emit({
        id,
        object: "chat.completion.chunk",
        created,
        model: request.model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      });
      if (request.stream_options?.include_usage && usage) {
        yield emit({
          id,
          object: "chat.completion.chunk",
          created,
          model: request.model,
          choices: [],
          usage,
        });
      }
    } else if (event.totalUsage) {
      usage = usageFromEvent(event);
    }
  }

  if (!sawContent && !sawToolCall) {
    // The terminal finish event still communicates the completion state.
  }
  yield "data: [DONE]\n\n";
}
