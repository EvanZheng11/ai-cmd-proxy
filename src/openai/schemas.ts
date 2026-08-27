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
  input: z.union([
    z.string(),
    z.array(messageSchema),
    z.array(contentPartSchema),
    z.array(z.unknown()),
  ]),
  instructions: z.string().optional(),
  stream: z.boolean().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).optional(),
  top_p: z.number().min(0).max(1).optional(),
  reasoning: z.object({
    effort: z.string().optional(),
  }).optional(),
  tools: z.array(toolSchema).optional(),
  text: z.object({
    format: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  previous_response_id: z.string().optional(),
}).passthrough();

export function parseResponsesRequest(input: unknown) {
  return responsesRequestSchema.parse(input);
}
