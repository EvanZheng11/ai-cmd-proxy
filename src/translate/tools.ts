import type { OpenAiTool } from "../openai/types.js";
import type { CommandCodeTool } from "../commandcode/types.js";

export function toCommandCodeTools(tools: OpenAiTool[] = []): CommandCodeTool[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? "",
    input_schema: tool.function.parameters ?? {
      type: "object",
      properties: {},
    },
  }));
}
