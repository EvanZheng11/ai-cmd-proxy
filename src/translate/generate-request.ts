import { parseChatCompletionRequest } from "../openai/schemas.js";
import type { ChatCompletionRequest } from "../openai/types.js";
import type { CommandCodeGenerateInput } from "../commandcode/types.js";
import { toCommandCodeMessages } from "./messages.js";
import { toCommandCodeTools } from "./tools.js";

function structuredOutputInstruction(request: ChatCompletionRequest): string {
  const format = request.response_format;
  if (!format || format.type === "text") {
    return "";
  }

  if (format.type === "json_object") {
    return "Return only a valid JSON object with no markdown fences or explanatory text.";
  }

  return [
    "Return only JSON that conforms to this JSON Schema:",
    JSON.stringify(format.json_schema ?? {}),
  ].join("\n");
}

export function toCommandCodeGenerateRequest(
  input: unknown,
  options: { defaultMaxTokens?: number } = {},
): CommandCodeGenerateInput {
  const request = parseChatCompletionRequest(input);
  const { messages, system } = toCommandCodeMessages(request.messages);
  const structuredInstruction = structuredOutputInstruction(request);
  const maxTokens = request.max_completion_tokens
    ?? request.max_tokens
    ?? options.defaultMaxTokens
    ?? 1_000_000;

  return {
    memory: null,
    taste: null,
    skills: null,
    permissionMode: "standard",
    mode: "agent",
    params: {
      model: request.model,
      messages,
      tools: toCommandCodeTools(request.tools),
      system: [system, structuredInstruction].filter(Boolean).join("\n\n"),
      max_tokens: maxTokens,
      stream: true,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.top_p === undefined ? {} : { top_p: request.top_p }),
      ...(request.stop === undefined || request.stop === null ? {} : { stop: request.stop }),
      ...(request.reasoning_effort === undefined
        ? {}
        : { reasoning_effort: request.reasoning_effort }),
    },
  };
}
