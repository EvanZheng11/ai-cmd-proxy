export type ProxyConfig = {
  host: string;
  port: number;
  commandCodeApiUrl: string;
  commandCodeVersion: string;
  defaultMaxTokens: number;
  requestTimeoutMs: number;
  maxRequestBytes: number;
};

function readNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: Record<string, string | undefined>): ProxyConfig {
  return {
    host: env.HOST ?? "127.0.0.1",
    port: readNumber(env.PORT, 3000),
    commandCodeApiUrl: env.COMMAND_CODE_API_URL ?? "https://api.commandcode.ai",
    commandCodeVersion: env.COMMAND_CODE_VERSION ?? "1.36.0",
    defaultMaxTokens: readNumber(env.DEFAULT_MAX_TOKENS, 1_000_000),
    requestTimeoutMs: readNumber(env.REQUEST_TIMEOUT_MS, 600_000),
    maxRequestBytes: readNumber(env.MAX_REQUEST_BYTES, 20_971_520),
  };
}
