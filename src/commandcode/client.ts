import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { ProxyConfig } from "../config.js";
import type {
  CommandCodeConfig,
  CommandCodeEvent,
  CommandCodeGenerateInput,
} from "./types.js";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type CommandCodeLogger = (message: string, context?: Record<string, unknown>) => void;
// 上游 /alpha/generate 对 params.max_tokens 的硬上限：超过会被 400 拒绝
// （"Too big: expected number to be <=200000"）。这里统一夹取，避免把
// 客户端的超大输出预算变成一次请求失败。
const COMMAND_CODE_MAX_TOKENS = 200_000;
const COMMAND_CODE_MAX_ATTEMPTS = 5;
const COMMAND_CODE_RETRY_DELAY_MS = 100;

export function sanitizeForLog(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (/authorization|api[-_]?key|token|secret|password/i.test(key)) {
      return "[REDACTED]";
    }
    if (value.startsWith("data:") && value.includes(";base64,")) {
      return `[base64 omitted: ${value.length} chars]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, key));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      childKey === "image" && record.type === "image" && typeof childValue === "string"
        ? `[base64 omitted: ${childValue.length} chars]`
        : sanitizeForLog(childValue, childKey),
    ]));
  }
  return value;
}

function imageSummary(request: CommandCodeGenerateInput): {
  imageCount: number;
  images: Array<{ mediaType: string; base64Length: number }>;
} {
  const images = request.params.messages.flatMap((message) => message.content.flatMap((part) =>
    part.type === "image"
      ? [{
          mediaType: part.mediaType ?? "unknown",
          base64Length: part.image.match(/^data:[^;]+;base64,(.*)$/s)?.[1]?.length ?? 0,
        }]
      : [],
  ));
  return { imageCount: images.length, images };
}

function isTerminalEvent(event: CommandCodeEvent): boolean {
  return ["finish", "error", "abort"].includes(event.type);
}

// 从上游 NDJSON 里抽出本次请求的缓存命中情况，便于在日志里直接核对
// agent 多轮对话的缓存率（无需回看可能被截断的完整响应体）。
function usageSummary(body: string): Record<string, unknown> {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.includes('"totalUsage"')) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as CommandCodeEvent;
      const usage = event.totalUsage;
      if (!usage) {
        continue;
      }
      const input = usage.inputTokens ?? 0;
      const cached = usage.cachedInputTokens
        ?? usage.inputTokenDetails?.cacheReadTokens
        ?? 0;
      return {
        inputTokens: input,
        cachedInputTokens: cached,
        cacheHitRate: input > 0 ? `${Math.round((cached / input) * 100)}%` : "0%",
      };
    } catch {
      // 单行解析失败不影响统计：继续找后续事件。
    }
  }
  return {};
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {});
  } catch {
    // 上游连接取消失败不应覆盖已有的业务错误。
  }
}

type ClientDependencies = {
  config: ProxyConfig;
  fetch?: FetchLike;
  createTempDir?: () => Promise<string>;
  removeTempDir?: (directory: string) => Promise<void>;
  now?: () => Date;
  platform?: () => string;
  createSessionId?: () => string;
  logger?: (message: string, context?: Record<string, unknown>) => void;
};

export type CommandCodeClient = {
  stream(input: {
    apiKey: string;
    request: CommandCodeGenerateInput;
    signal?: AbortSignal;
  }): AsyncIterable<CommandCodeEvent>;
};

export class CommandCodeUpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "CommandCodeUpstreamError";
  }
}

// 上游报错有两种形状，状态码字段名不同，都要认：
//   HTTP 4xx 体：{"success":false,"error":{"code":"FORBIDDEN","status":403,"message":"..."}}
//   NDJSON 事件：{"type":"error","error":{...},"statusCode":400}
// 若不提取，池化网关会把"套餐不含该模型"误判成上游故障。
export function upstreamErrorStatus(body: string | undefined, fallback: number): number {
  if (!body) {
    return fallback;
  }
  const asStatus = (value: unknown): number | undefined =>
    typeof value === "number" && value >= 400 ? value : undefined;
  try {
    const parsed = JSON.parse(body) as {
      status?: unknown;
      statusCode?: unknown;
      error?: { status?: unknown; statusCode?: unknown } | string;
    };
    const nested = typeof parsed.error === "object" && parsed.error !== null
      ? parsed.error
      : undefined;
    return asStatus(parsed.status)
      ?? asStatus(parsed.statusCode)
      ?? asStatus(nested?.status)
      ?? asStatus(nested?.statusCode)
      ?? fallback;
  } catch {
    return fallback;
  }
}

function toCommandCodeConfig(
  workingDir: string,
  now: Date,
  platform: string,
): CommandCodeConfig {
  return {
    workingDir,
    date: now.toISOString().slice(0, 10),
    environment: platform,
    structure: [],
    isGitRepo: false,
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [],
  };
}

async function* readNdjson(
  response: Response,
  onBody?: (body: string) => void,
): AsyncIterable<CommandCodeEvent> {
  if (!response.body) {
    throw new CommandCodeUpstreamError("CommandCode returned an empty response body", 502);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let sawTerminalEvent = false;
  let responseBody = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const decoded = decoder.decode(value, { stream: true });
      buffered += decoded;
      responseBody += decoded;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          try {
            const event = JSON.parse(trimmed) as CommandCodeEvent;
            sawTerminalEvent ||= isTerminalEvent(event);
            if (isTerminalEvent(event)) {
              cancelReader(reader);
              yield event;
              return;
            }
            yield event;
          } catch {
            throw new CommandCodeUpstreamError("CommandCode returned malformed NDJSON", 502);
          }
        }
      }
    }

    const decodedTrailing = decoder.decode();
    responseBody += decodedTrailing;
    const trailing = `${buffered}${decodedTrailing}`.trim();
    if (trailing) {
      try {
        const event = JSON.parse(trailing) as CommandCodeEvent;
        sawTerminalEvent ||= isTerminalEvent(event);
        if (isTerminalEvent(event)) {
          cancelReader(reader);
          yield event;
          return;
        }
        yield event;
      } catch {
        throw new CommandCodeUpstreamError("CommandCode returned malformed NDJSON", 502);
      }
    }
    if (!sawTerminalEvent) {
      throw new CommandCodeUpstreamError("CommandCode returned an incomplete NDJSON stream", 502);
    }
  } finally {
    onBody?.(responseBody);
    cancelReader(reader);
    reader.releaseLock();
  }
}

export function createCommandCodeClient(dependencies: ClientDependencies): CommandCodeClient {
  const fetchImpl = dependencies.fetch ?? fetch;
  const createTempDir = dependencies.createTempDir
    ?? (() => mkdtemp(join(tmpdir(), "ai-cmd-proxy-")));
  const removeTempDir = dependencies.removeTempDir
    ?? (async (directory: string) => rm(directory, { recursive: true, force: true }));
  const now = dependencies.now ?? (() => new Date());
  const platform = dependencies.platform ?? (() => process.platform);
  const createSessionId = dependencies.createSessionId ?? randomUUID;
  const logger: CommandCodeLogger = dependencies.logger ?? ((message, context) => {
    console.info(message, context);
  });
  const writeLog = (message: string, context: Record<string, unknown>) => {
    try {
      logger(message, context);
    } catch {
      // 日志故障不能影响上游请求和临时目录清理。
    }
  };
  const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    }, { once: true });
  });

  return {
    async *stream({ apiKey, request, signal }): AsyncIterable<CommandCodeEvent> {
      const workingDir = await createTempDir();
      const startedAt = Date.now();
      let sessionId = "";

      try {
        const timeoutSignal = AbortSignal.timeout(dependencies.config.requestTimeoutMs);
        const requestSignal = signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal;
        sessionId = createSessionId();
        writeLog("CommandCode 请求开始", {
          model: request.params.model,
          sessionId,
        });
        const url = new URL("/alpha/generate", dependencies.config.commandCodeApiUrl).toString();
        const headers = {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "user-agent": "cli",
          "x-command-code-version": dependencies.config.commandCodeVersion,
          "x-cli-environment": "production",
          "x-taste-learning": "true",
          "x-session-id": sessionId,
        };
        const payload = {
          ...request,
          params: {
            ...request.params,
            max_tokens: Math.min(request.params.max_tokens, COMMAND_CODE_MAX_TOKENS),
          },
          config: toCommandCodeConfig(workingDir, now(), platform()),
        };
        const images = imageSummary(payload);
        if (images.imageCount > 0) {
          writeLog("CommandCode 图片参数摘要", images);
        }
        writeLog("CommandCode 上游请求参数", {
          url,
          method: "POST",
          headers: sanitizeForLog(headers) as Record<string, unknown>,
          body: JSON.stringify(sanitizeForLog(payload)),
        });
        let response = await fetchImpl(url, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal: requestSignal,
        });
        const responseHeaders = Object.fromEntries(response.headers.entries());
        let responseBody: string | undefined;
        if (!response.ok) {
          responseBody = await response.text();
        }
        writeLog("CommandCode 上游响应详情", {
          status: response.status,
          headers: responseHeaders,
          ...(responseBody === undefined ? {} : { body: responseBody }),
        });
        writeLog("CommandCode 响应已收到", {
          model: request.params.model,
          sessionId,
          status: response.status,
          durationMs: Date.now() - startedAt,
        });

        if (!response.ok) {
          // 上游 4xx 也可能把真实原因放在响应体里（如 MODEL_NOT_IN_PLAN 是 403）。
          throw new CommandCodeUpstreamError(
            `CommandCode returned HTTP ${response.status}`,
            upstreamErrorStatus(responseBody, response.status),
            responseBody,
          );
        }

        yield* readNdjson(response, (body) => {
          writeLog("CommandCode 上游响应体", { body });
          writeLog("CommandCode 缓存命中统计", usageSummary(body));
        });
      } catch (error) {
        const errorName = error instanceof Error ? error.name : "UnknownError";
        const errorStatus = error instanceof CommandCodeUpstreamError
          ? error.status
          : undefined;
        writeLog("CommandCode 请求失败", {
          model: request.params.model,
          sessionId,
          status: errorStatus,
          durationMs: Date.now() - startedAt,
          error: errorName,
        });
        if (error instanceof CommandCodeUpstreamError) {
          if (signal?.aborted) throw error;
          throw error;
        }
        const isTimeout = errorName === "TimeoutError" || errorName === "AbortError";
        throw new CommandCodeUpstreamError(
          isTimeout ? "CommandCode request timed out" : "CommandCode request failed",
          isTimeout ? 504 : 502,
        );
      } finally {
        try {
          await removeTempDir(workingDir);
        } catch (error) {
          writeLog("CommandCode 临时目录清理失败", {
            model: request.params.model,
            sessionId,
            error: error instanceof Error ? error.name : "UnknownError",
          });
        }
      }
    },
  };
}
