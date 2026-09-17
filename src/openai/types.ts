export type OpenAiContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: {
        url: string;
        detail?: "auto" | "low" | "high";
      };
    };

export type OpenAiTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
};

export type OpenAiChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | OpenAiContentPart[] | null;
  reasoning_content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

export type ChatCompletionRequest = {
  model: string;
  messages: OpenAiChatMessage[];
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[] | null;
  reasoning_effort?: string;
  tools?: OpenAiTool[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  response_format?: {
    type: "text" | "json_object" | "json_schema";
    json_schema?: Record<string, unknown>;
  };
};

export type ResponsesFunctionTool = OpenAiTool | ({ type: "function" } & OpenAiTool["function"]);

export type ResponsesTool = ResponsesFunctionTool | {
  type: "namespace";
  name: string;
  description?: string;
  tools: ResponsesFunctionTool[];
};

export type ResponsesRequest = {
  model: string;
  input: string | OpenAiChatMessage[] | OpenAiContentPart[] | unknown[];
  instructions?: string;
  stream?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning?: {
    effort?: string;
  };
  tools?: ResponsesTool[];
  text?: {
    format?: Record<string, unknown>;
  };
  previous_response_id?: string;
};
