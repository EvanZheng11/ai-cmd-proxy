export type CommandCodeContentBlock =
  | {
      type: "reasoning";
      text: string;
    }
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      image: string;
      mediaType?: string;
    }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      output: unknown;
    };

export type CommandCodeMessage = {
  role: "user" | "assistant" | "tool";
  content: CommandCodeContentBlock[];
};

export type CommandCodeTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

// 上游 /alpha/generate 只接受对象形式的 tool_choice（字符串形式会被
// zod 校验拒绝：expected object, received string）。auto/required/none 只有
// type 字段；指定工具时用具名工具的 type=tool + name。
export type CommandCodeToolChoice =
  | { type: "auto" }
  | { type: "required" }
  | { type: "none" }
  | { type: "tool"; name: string };

export type CommandCodeGenerateInput = {
  memory: null;
  taste: null;
  skills: null;
  permissionMode: "standard" | "auto-accept" | "plan";
  mode: "agent" | "learning" | "custom-agent" | "custom-agent-create" | "title-gen" | "tool-desc" | "compact" | "vision";
  params: {
    model: string;
    messages: CommandCodeMessage[];
    tools: CommandCodeTool[];
    system: string;
    max_tokens: number;
    stream: true;
    temperature?: number;
    top_p?: number;
    stop?: string | string[];
    reasoning_effort?: string;
    tool_choice?: CommandCodeToolChoice;
  };
};

export type CommandCodeConfig = {
  workingDir: string;
  date: string;
  environment: string;
  structure: string[];
  isGitRepo: boolean;
  currentBranch: string;
  mainBranch: string;
  gitStatus: string;
  recentCommits: string[];
};

export type CommandCodeEvent = {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  args?: unknown;
  output?: unknown;
  result?: unknown;
  isError?: boolean;
  providerExecuted?: boolean;
  finishReason?: string;
  rawFinishReason?: string;
  totalUsage?: CommandCodeUsage;
  systemPromptTokens?: number;
  // 错误事件有两种形状，状态码位置不同：
  //   {"type":"error","error":{"message":"...","statusCode":400}}
  //   {"type":"error","error":"failed","statusCode":502}
  error?: string | {
    message?: string;
    statusCode?: number;
  };
  statusCode?: number;
  isRetryable?: boolean;
};

// 上游在 finish/finish-step 里回传的用量。缓存命中信息同时出现在
// cachedInputTokens（顶层）与 inputTokenDetails.cacheReadTokens（嵌套）中，
// 两者都读取以避免只认一种形状时把缓存率算成 0。
export type CommandCodeUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  totalTokens?: number;
  reasoningTokens?: number;
};
