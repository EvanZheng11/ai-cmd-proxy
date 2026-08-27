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

function isTerminalEvent(event: CommandCodeEvent): boolean {
  return ["finish", "error", "abort"].includes(event.type);
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

async function* readNdjson(response: Response): AsyncIterable<CommandCodeEvent> {
  if (!response.body) {
    throw new CommandCodeUpstreamError("CommandCode returned an empty response body", 502);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let sawTerminalEvent = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffered += decoder.decode(value, { stream: true });
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

    const trailing = `${buffered}${decoder.decode()}`.trim();
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
        const response = await fetchImpl(
          new URL("/alpha/generate", dependencies.config.commandCodeApiUrl).toString(),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
              "user-agent": "cli",
              "x-command-code-version": dependencies.config.commandCodeVersion,
              "x-cli-environment": "production",
              "x-taste-learning": "true",
              "x-session-id": sessionId,
            },
            body: JSON.stringify({
              ...request,
              config: toCommandCodeConfig(workingDir, now(), platform()),
            }),
            signal: requestSignal,
          },
        );
        writeLog("CommandCode 响应已收到", {
          model: request.params.model,
          sessionId,
          status: response.status,
          durationMs: Date.now() - startedAt,
        });

        if (!response.ok) {
          throw new CommandCodeUpstreamError(
            `CommandCode returned HTTP ${response.status}`,
            response.status,
            await response.text(),
          );
        }

        yield* readNdjson(response);
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
