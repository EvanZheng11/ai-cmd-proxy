import { parseChatCompletionRequest } from "../openai/schemas.js";
import type {
  CommandCodeGenerateInput,
  CommandCodeToolChoice,
} from "../commandcode/types.js";
import { toCommandCodeMessages } from "./messages.js";
import { toCommandCodeTools } from "./tools.js";

// OpenAI 的 tool_choice 既可以是字符串（"auto"/"none"/"required"）也可以是对象，
// 上游只接受对象形式。无法表达成上游语义的具名对象返回 undefined，由调用方决定
// 是降级还是报错。
function toCommandCodeToolChoice(toolChoice: unknown): CommandCodeToolChoice | undefined {
  if (toolChoice === undefined || toolChoice === null) {
    return undefined;
  }

  if (typeof toolChoice === "string") {
    return toolChoice === "auto" || toolChoice === "none" || toolChoice === "required"
      ? { type: toolChoice }
      : undefined;
  }

  if (typeof toolChoice !== "object") {
    return undefined;
  }

  const value = toolChoice as Record<string, unknown>;
  if (value.type === "auto" || value.type === "none" || value.type === "required") {
    return { type: value.type };
  }
  if (value.type === "function") {
    const fn = value.function as Record<string, unknown> | undefined;
    const name = typeof fn?.name === "string" ? fn.name : undefined;
    // 上游用具名工具的 tool_choice 是 {type:"tool", name}，缺少工具名时无法表达。
    return name ? { type: "tool", name } : undefined;
  }
  if (value.type === "tool" && typeof value.name === "string") {
    return { type: "tool", name: value.name };
  }

  return undefined;
}

export function toCommandCodeGenerateRequest(
  input: unknown,
  options: { defaultMaxTokens?: number } = {},
): CommandCodeGenerateInput {
  const request = parseChatCompletionRequest(input);
  if (request.response_format && request.response_format.type !== "text") {
    throw new Error("Structured output is not supported by the CommandCode upstream");
  }
  const toolChoice = toCommandCodeToolChoice(request.tool_choice);
  // parallel_tool_calls 是 OpenAI 侧的执行提示；上游没有对应字段，且模型本身
  // 可以在一次回复里给出多个 tool-call，因此忽略它即可，不应让请求失败。
  const { messages, system } = toCommandCodeMessages(request.messages);
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
      system,
      max_tokens: maxTokens,
      stream: true,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.top_p === undefined ? {} : { top_p: request.top_p }),
      ...(request.stop === undefined || request.stop === null ? {} : { stop: request.stop }),
      ...(request.reasoning_effort === undefined
        ? {}
        : { reasoning_effort: request.reasoning_effort }),
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    },
  };
}
