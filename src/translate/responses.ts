import { randomUUID } from "node:crypto";

import { parseResponsesRequest } from "../openai/schemas.js";
import type { ChatCompletionRequest, ResponsesRequest } from "../openai/types.js";
import type { CommandCodeEvent } from "../commandcode/types.js";
import { UpstreamStreamError } from "../errors.js";
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
  };
};

function normalizeInput(input: ResponsesRequest["input"]): ChatCompletionRequest["messages"] {
  const normalizeParts = (parts: unknown[]) => parts.map((part) => {
    if (!part || typeof part !== "object") {
      return part;
    }
    const value = part as Record<string, unknown>;
    if (value.type === "input_text" && typeof value.text === "string") {
      return { type: "text" as const, text: value.text };
    }
    if (value.type === "input_image") {
      const imageUrl = typeof value.image_url === "string"
        ? value.image_url
        : value.image_url && typeof value.image_url === "object"
          ? String((value.image_url as Record<string, unknown>).url ?? "")
          : "";
      return { type: "image_url" as const, image_url: { url: imageUrl } };
    }
    return part;
  });

  if (typeof input === "string") {
    return [{ role: "user" as const, content: input }];
  }

  if (Array.isArray(input) && input.every((item) => typeof item === "object" && item !== null && "role" in item)) {
    return (input as Array<Record<string, unknown>>).map((message) => ({
      ...message,
      ...(Array.isArray(message.content)
        ? { content: normalizeParts(message.content) }
        : {}),
    })) as ChatCompletionRequest["messages"];
  }

  return [{ role: "user" as const, content: normalizeParts(input as unknown[]) as never }];
}

export function toChatRequestFromResponses(input: unknown): ChatCompletionRequest {
  const request = parseResponsesRequest(input);
  return {
    model: request.model,
    messages: [
      ...(request.instructions
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
    ...(request.text?.format === undefined
      ? {}
      : {
          response_format: {
            type: "json_schema" as const,
            json_schema: request.text.format,
          },
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
  const input = event.totalUsage?.inputTokens;
  const output = event.totalUsage?.outputTokens;
  if (input === undefined && output === undefined) {
    return undefined;
  }
  return {
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    total_tokens: (input ?? 0) + (output ?? 0),
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
      throw new UpstreamStreamError(message, event.statusCode ?? 502);
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
  const messageId = `msg_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let text = "";
  let usage: ResponseState["usage"];
  let toolIndex = 0;

  const response = {
    ...responseSkeleton(id, model),
    status: "in_progress",
    output: [],
  };
  const emit = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

  yield emit("response.created", { response });
  yield emit("response.output_item.added", {
    output_index: 0,
    item: {
      id: messageId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    },
  });
  yield emit("response.content_part.added", {
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });

  for await (const event of events) {
    if (event.type === "error" || event.type === "abort") {
      const message = typeof event.error === "string"
        ? event.error
        : event.error?.message ?? "CommandCode stream aborted";
      throw new UpstreamStreamError(message, event.statusCode ?? 502);
    } else if (event.type === "text-delta" && event.text) {
      text += event.text;
      yield emit("response.output_text.delta", {
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        delta: event.text,
      });
    } else if (event.type === "reasoning-delta" && event.text) {
      yield emit("response.reasoning_summary_text.delta", {
        item_id: messageId,
        output_index: 0,
        summary_index: 0,
        delta: event.text,
      });
    } else if (event.type === "tool-call") {
      const callId = event.toolCallId ?? `call_${randomUUID()}`;
      const name = event.toolName ?? "";
      const args = typeof event.input === "string"
        ? event.input
        : JSON.stringify(event.input ?? event.args ?? {});
      const outputIndex = toolIndex++;
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

  yield emit("response.output_text.done", {
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    text,
  });
  yield emit("response.content_part.done", {
    item_id: messageId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text, annotations: [] },
  });
  yield emit("response.output_item.done", {
    output_index: 0,
    item: {
      id: messageId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  });
  yield emit("response.completed", {
    response: {
      ...responseSkeleton(id, model),
      status: "completed",
      output: [{
        id: messageId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      }],
      ...(usage ? { usage } : {}),
    },
  });
}
