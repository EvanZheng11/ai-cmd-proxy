export type CommandCodeContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      media_type: string;
      data: string;
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
  totalUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: {
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
  };
  systemPromptTokens?: number;
  error?: string | {
    message?: string;
  };
  statusCode?: number;
  isRetryable?: boolean;
};
