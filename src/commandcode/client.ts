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
const COMMAND_CODE_MAX_ATTEMPTS = 3;
const COMMAND_CODE_RETRY_DELAY_MS = 100;
const RETRYABLE_HTTP_STATUSES = new Set([502, 503, 504]);
const RETRYABLE_CAUSE_CODES = new Set([
  "ECONNRESET", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_SOCKET",
  "CONNECT_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT",
]);

export function sanitizeForLog(value: unknown, key = "", secrets: readonly string[] = []): unknown {
  if (typeof value === "string") {
    if (/authorization|api[-_]?key|token|secret|password/i.test(key)) {
      return "[REDACTED]";
    }
    if (value.startsWith("data:") && value.includes(";base64,")) {
      return `[base64 omitted: ${value.length} chars]`;
    }
    const redacted = value
      .replace(/\bBearer\s+[^\s,;"'<>]+/gi, "Bearer [REDACTED]")
      // 转义字符成对消费，避免把 \" 或 \' 误当成敏感值的结束引号。
      .replace(/((?:["']?)(?:api[-_]?key|password|token|secret)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;}]+)/gi, "$1[REDACTED]");
    // 实际凭证也可能藏在普通字段或异常文本中，先替换较长的转义形式。
    const secretVariants = secrets.filter(Boolean).flatMap((secret) => [
      secret,
      JSON.stringify(secret).slice(1, -1),
      secret.replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    ]).sort((left, right) => right.length - left.length);
    return secretVariants.reduce((text, secret) => text.split(secret).join("[REDACTED]"), redacted);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, key, secrets));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      childKey === "image" && record.type === "image" && typeof childValue === "string"
        ? `[base64 omitted: ${childValue.length} chars]`
        : sanitizeForLog(childValue, childKey, secrets),
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
function usageSummary(event: CommandCodeEvent): Record<string, unknown> {
  const usage = event.totalUsage;
  if (!usage) return {};
  const input = usage.inputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? usage.inputTokenDetails?.cacheReadTokens ?? 0;
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    cacheHitRate: input > 0 ? `${Math.round((cached / input) * 100)}%` : "0%",
  };
}

function errorDetails(error: unknown): { errorMessage: string; causeCode?: string } {
  const messages: string[] = [];
  const visited = new Set<unknown>();
  let causeCode: string | undefined;
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const detail = current as { message?: unknown; code?: unknown; cause?: unknown };
    // JSON.parse 的异常消息可能带原始响应片段，只保留类别，cause 对象照常向上传递。
    if (current instanceof SyntaxError) messages.push("响应解析失败");
    else if (typeof detail.message === "string") messages.push(detail.message);
    if (!causeCode && typeof detail.code === "string") causeCode = detail.code;
    current = detail.cause;
  }
  return { errorMessage: messages.join(": ") || (typeof error === "string" ? error : "未知错误"), causeCode };
}

// 即使注入的 fetch/read 不响应 signal，也必须在同一预算内退出，并移除监听器。
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    operation.then((value) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.aborted ? signal.reason : error);
    });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function cancelBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // 清理失败不能覆盖请求的原始错误。
  }
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
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
};

export type CommandCodeClient = {
  stream(input: {
    apiKey: string;
    request: CommandCodeGenerateInput;
    signal?: AbortSignal;
    requestId?: string;
  }): AsyncIterable<CommandCodeEvent>;
};

export class CommandCodeUpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
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
  signal: AbortSignal,
): AsyncIterable<CommandCodeEvent> {
  if (!response.body) {
    throw new CommandCodeUpstreamError("CommandCode returned an empty response body", 502);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let sawTerminalEvent = false;

  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await abortable(reader.read(), signal);
      if (done) {
        break;
      }

      const decoded = decoder.decode(value, { stream: true });
      buffered += decoded;
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
          } catch (cause) {
            throw new CommandCodeUpstreamError("CommandCode returned malformed NDJSON", 502, undefined, { cause });
          }
        }
      }
    }

    const decodedTrailing = decoder.decode();
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
      } catch (cause) {
        throw new CommandCodeUpstreamError("CommandCode returned malformed NDJSON", 502, undefined, { cause });
      }
    }
    if (!sawTerminalEvent) {
      throw new CommandCodeUpstreamError("CommandCode returned an incomplete NDJSON stream", 502);
    }
  } finally {
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
  // config.workingDir 会随请求体进入上游提示词前缀：每个请求都换随机临时目录
  // 会让提示词缓存前缀失配（缓存命中永远停在系统提示词那一段）。这里改为
  // 每个客户端实例首次请求时创建一个固定工作目录，之后所有请求复用同一
  // 前缀；目录随进程存活，由系统临时目录机制回收。
  let workingDirPromise: Promise<string> | undefined;
  const getWorkingDir = (): Promise<string> => {
    if (!workingDirPromise) {
      workingDirPromise = createTempDir().catch((error: unknown) => {
        // 创建失败允许后续请求重试，避免一次临时故障永久阻塞客户端。
        workingDirPromise = undefined;
        throw error;
      });
    }
    return workingDirPromise;
  };
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
  const delay = dependencies.delay ?? retryDelay;
  const random = dependencies.random ?? Math.random;

  return {
    async *stream({ apiKey, request, signal, requestId }): AsyncIterable<CommandCodeEvent> {
      const startedAt = Date.now();
      let sessionId = "";
      let attempt = 0;
      let stage = "setup";
      let eventsReceived = 0;
      const controller = new AbortController();
      const requestSignal = controller.signal;
      const onAbort = () => controller.abort(signal?.reason);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => {
        controller.abort(new DOMException("CommandCode 总超时预算耗尽", "TimeoutError"));
      }, dependencies.config.requestTimeoutMs);
      const log = (message: string, context: Record<string, unknown> = {}) => {
        // 不传 Error 对象或 body 给 logger；在所有元数据里替换当前真实凭证。
        writeLog(message, sanitizeForLog({
          model: request.params.model, sessionId, requestId: requestId ?? null, attempt, stage, eventsReceived,
          durationMs: Date.now() - startedAt, errorMessage: "", ...context, causeCode: context.causeCode ?? null,
        }, "", [apiKey]) as Record<string, unknown>);
      };

      try {
        requestSignal.throwIfAborted();
        sessionId = createSessionId();
        // 放在 try 内：workingDir 创建失败要归一化成 CommandCodeUpstreamError。
        const workingDir = await abortable(getWorkingDir(), requestSignal);
        log("CommandCode 请求开始");
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
          log("CommandCode 图片参数摘要", images);
        }
        log("CommandCode 上游请求参数", {
          url,
          method: "POST",
          headers,
          maxTokens: payload.params.max_tokens,
          messageCount: payload.params.messages.length,
        });
        const body = JSON.stringify(payload);
        for (attempt = 1; attempt <= COMMAND_CODE_MAX_ATTEMPTS; attempt += 1) {
          let response: Response | undefined;
          let retryError: unknown;
          try {
            stage = "fetch";
            requestSignal.throwIfAborted();
            response = await abortable<Response>(fetchImpl(url, {
              method: "POST", headers, body, signal: requestSignal,
            }).then((value) => {
              // fetch 若忽略取消并迟到返回，也要释放连接。
              if (requestSignal.aborted) cancelBody(value);
              return value;
            }), requestSignal);
            log("CommandCode 上游响应详情", {
              status: response.status,
              headers: { "x-request-id": response.headers.get("x-request-id") },
            });
            log("CommandCode 响应已收到", { status: response.status });
            if (!response.ok) {
              stage = "http-body";
              // 可恢复的网关错误直接丢弃 body，避免错误页读取阻塞下一次尝试。
              let responseBody: string | undefined;
              if (!RETRYABLE_HTTP_STATUSES.has(response.status) && response.body) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                responseBody = "";
                try {
                  while (true) {
                    const chunk = await abortable(reader.read(), requestSignal);
                    if (chunk.done) break;
                    responseBody += decoder.decode(chunk.value, { stream: true });
                  }
                  responseBody += decoder.decode();
                } catch (cause) {
                  throw new CommandCodeUpstreamError(`CommandCode returned HTTP ${response.status}`, response.status, undefined, { cause });
                } finally {
                  cancelReader(reader);
                  reader.releaseLock();
                }
              }
              throw new CommandCodeUpstreamError(
                `CommandCode returned HTTP ${response.status}`,
                upstreamErrorStatus(responseBody, response.status), responseBody,
              );
            }
            stage = "read";
            for await (const event of readNdjson(response, requestSignal)) {
              requestSignal.throwIfAborted();
              eventsReceived += 1;
              if (event.totalUsage) log("CommandCode 缓存命中统计", usageSummary(event));
              yield event;
            }
            log("CommandCode 请求完成");
            return;
          } catch (error) {
            const details = errorDetails(error);
            const errorName = error instanceof Error ? error.name : "UnknownError";
            const retryable = error instanceof CommandCodeUpstreamError
              ? stage === "http-body" && RETRYABLE_HTTP_STATUSES.has(response?.status ?? 0)
                && RETRYABLE_HTTP_STATUSES.has(error.status)
              : (stage === "fetch" || stage === "read") && RETRYABLE_CAUSE_CODES.has(details.causeCode ?? "");
            if (requestSignal.aborted || errorName === "AbortError" || errorName === "TimeoutError"
              || eventsReceived > 0 || attempt === COMMAND_CODE_MAX_ATTEMPTS || !retryable) {
              throw error;
            }
            retryError = error;
          } finally {
            if (response && !response.body?.locked && !response.bodyUsed) cancelBody(response);
          }
          const delayMs = COMMAND_CODE_RETRY_DELAY_MS * 2 ** (attempt - 1) + Math.floor(random() * 50);
          log("CommandCode 请求重试", { ...errorDetails(retryError), delayMs });
          stage = "backoff";
          requestSignal.throwIfAborted();
          await abortable(delay(delayMs, requestSignal), requestSignal);
        }
      } catch (error) {
        const errorName = error instanceof Error ? error.name : "UnknownError";
        const isTimeout = requestSignal.reason?.name === "TimeoutError" || errorName === "TimeoutError";
        const cancelled = signal?.aborted || errorName === "AbortError";
        const status = isTimeout ? 504 : cancelled ? 499 : error instanceof CommandCodeUpstreamError ? error.status : 502;
        log("CommandCode 请求失败", { status, error: errorName, ...errorDetails(error) });
        if (error instanceof CommandCodeUpstreamError && !requestSignal.aborted) throw error;
        throw new CommandCodeUpstreamError(
          isTimeout ? "CommandCode request timed out" : cancelled ? "CommandCode request cancelled" : "CommandCode request failed",
          status, undefined, { cause: error },
        );
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
