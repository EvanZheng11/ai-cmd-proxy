import { randomUUID } from "node:crypto";

import { parseResponsesRequest } from "../openai/schemas.js";
import type { ChatCompletionRequest, ResponsesRequest } from "../openai/types.js";
import type { CommandCodeEvent } from "../commandcode/types.js";
import { toCommandCodeGenerateRequest } from "./generate-request.js";

type ResponseState = {
  text: string;
  finishReason: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
};

function normalizeInput(input: ResponsesRequest["input"]): ChatCompletionRequest["messages"] {
  if (typeof input === "string") {
    return [{ role: "user" as const, content: input }];
  }

  if (Array.isArray(input) && input.every((item) => typeof item === "object" && item !== null && "role" in item)) {
    return input as ChatCompletionRequest["messages"];
  }

  return [{ role: "user" as const, content: input as never }];
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
    ...(request.tools === undefined ? {} : { tools: request.tools }),
  };
}

export function toCommandCodeResponsesRequest(input: unknown) {
  return toCommandCodeGenerateRequest(toChatRequestFromResponses(input));
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
  const state: ResponseState = { text: "", finishReason: "stop" };
  for (const event of events) {
    if (event.type === "text-delta") {
      state.text += event.text ?? "";
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
  return {
    ...response,
    output: [{
      id: `msg_${randomUUID()}`,
      type: "message" as const,
      status: "completed" as const,
      role: "assistant" as const,
      content: [{
        type: "output_text" as const,
        text: state.text,
        annotations: [],
      }],
    }],
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
    if (event.type === "text-delta" && event.text) {
      text += event.text;
      yield emit("response.output_text.delta", {
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        delta: event.text,
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
