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

type ClientDependencies = {
  config: ProxyConfig;
  fetch?: FetchLike;
  createTempDir?: () => Promise<string>;
  removeTempDir?: (directory: string) => Promise<void>;
  now?: () => Date;
  platform?: () => string;
  createSessionId?: () => string;
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
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

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
          yield JSON.parse(trimmed) as CommandCodeEvent;
        }
      }
    }

    const trailing = `${buffered}${decoder.decode()}`.trim();
    if (trailing) {
      yield JSON.parse(trailing) as CommandCodeEvent;
    }
  } finally {
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

  return {
    async *stream({ apiKey, request, signal }): AsyncIterable<CommandCodeEvent> {
      const workingDir = await createTempDir();
      const timeoutSignal = AbortSignal.timeout(dependencies.config.requestTimeoutMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

      try {
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
              "x-session-id": createSessionId(),
            },
            body: JSON.stringify({
              ...request,
              config: toCommandCodeConfig(workingDir, now(), platform()),
            }),
            signal: requestSignal,
          },
        );

        if (!response.ok) {
          throw new CommandCodeUpstreamError(
            `CommandCode returned HTTP ${response.status}`,
            response.status,
            await response.text(),
          );
        }

        yield* readNdjson(response);
      } finally {
        await removeTempDir(workingDir);
      }
    },
  };
}
