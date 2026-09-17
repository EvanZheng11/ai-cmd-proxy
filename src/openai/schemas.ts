import { z } from "zod";

const contentPartSchema = z.union([
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({
      url: z.string().min(1),
      detail: z.enum(["auto", "low", "high"]).optional(),
    }),
  }),
]);

const messageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(contentPartSchema)]).nullable().optional(),
  reasoning_content: z.string().nullable().optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.object({
    id: z.string(),
    type: z.literal("function"),
    function: z.object({
      name: z.string(),
      arguments: z.string(),
    }),
  })).optional(),
});

const toolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

const responsesFunctionToolSchema = z.union([
  toolSchema,
  z.object({
    type: z.literal("function"),
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
]);

const responsesToolSchema = z.union([
  responsesFunctionToolSchema,
  z.object({
    type: z.literal("namespace"),
    name: z.string().min(1),
    description: z.string().optional(),
    tools: z.array(responsesFunctionToolSchema),
  }),
]);

export class ResponsesTranslationError extends Error {
  readonly statusCode = 400;
  readonly type = "invalid_request_error";

  constructor(message: string, public readonly param: string, public readonly code: string) {
    super(message);
    this.name = "ResponsesTranslationError";
  }
}

export function parseResponsesTools(input: unknown) {
  // 在 union 校验前指出不支持的具体工具，避免只返回笼统的 invalid_union。
  const checkTypes = (tools: unknown, path: string, allowNamespace: boolean) => {
    if (!Array.isArray(tools)) return;
    tools.forEach((tool, index) => {
      if (!tool || typeof tool !== "object") return;
      const param = `${path}[${index}]`;
      if (tool.type === "namespace" && allowNamespace) {
        checkTypes(tool.tools, `${param}.tools`, false);
      } else if (typeof tool.type === "string" && tool.type !== "function") {
        throw new ResponsesTranslationError(`不支持工具类型 ${tool.type}，仅支持 function 和 namespace 内的 function`, `${param}.type`, "unsupported_tool_type");
      }
    });
  };
  checkTypes(input, "tools", true);
  return z.array(responsesToolSchema).parse(input);
}

export const chatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional(),
  stream_options: z.object({
    include_usage: z.boolean().optional(),
  }).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string()).min(1)]).nullable().optional(),
  reasoning_effort: z.string().optional(),
  tools: z.array(toolSchema).optional(),
  tool_choice: z.unknown().optional(),
  parallel_tool_calls: z.boolean().optional(),
  response_format: z.object({
    type: z.enum(["text", "json_object", "json_schema"]),
    json_schema: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
}).passthrough();

export function parseChatCompletionRequest(input: unknown) {
  return chatCompletionRequestSchema.parse(input);
}

export const responsesRequestSchema = z.object({
  model: z.string().min(1),
  // Responses 条目的附加语义由转换器校验，不能先按 Chat schema 剥掉字段。
  input: z.union([z.string(), z.array(z.unknown())]),
  instructions: z.string().optional(),
  stream: z.boolean().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).optional(),
  top_p: z.number().min(0).max(1).optional(),
  reasoning: z.object({
    effort: z.string().optional(),
  }).optional(),
  tools: z.array(responsesToolSchema).optional(),
  text: z.object({
    format: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  previous_response_id: z.string().optional(),
}).passthrough();

export function parseResponsesRequest(input: unknown) {
  if (input && typeof input === "object" && "tools" in input && input.tools !== undefined) {
    parseResponsesTools(input.tools);
  }
  return responsesRequestSchema.parse(input);
}
