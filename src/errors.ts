export type OpenAiErrorType =
  | "authentication_error"
  | "invalid_request_error"
  | "api_error"
  | "rate_limit_error";

export type OpenAiErrorBody = {
  error: {
    message: string;
    type: OpenAiErrorType;
    param: string | null;
    code: string | null;
  };
};

export type OpenAiErrorOptions = {
  type?: OpenAiErrorType;
  param?: string | null;
  code?: string | null;
};

export class UpstreamStreamError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "UpstreamStreamError";
  }
}

// 上游 NDJSON 错误事件的状态码位置不统一：既可能在顶层 statusCode，
// 也可能嵌在 error.statusCode 里。两处都取不到时按 502 处理。
export function eventStatusCode(event: {
  statusCode?: number;
  error?: string | { statusCode?: number };
}): number {
  if (typeof event.statusCode === "number" && event.statusCode >= 400) {
    return event.statusCode;
  }
  if (typeof event.error === "object" && event.error !== null) {
    const nested = event.error.statusCode;
    if (typeof nested === "number" && nested >= 400) {
      return nested;
    }
  }
  return 502;
}

// 把上游错误体里的可读消息透传给客户端（例如 "MODEL_NOT_IN_PLAN"），
// 便于 sub2api 之类的池化网关判断该换账号还是该换模型。
export function upstreamErrorMessage(body: string | undefined, fallback: string): string {
  if (!body) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(body) as {
      message?: unknown;
      error?: { message?: unknown } | string;
    };
    const nested = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    const message = typeof nested === "string" && nested
      ? nested
      : typeof parsed.message === "string" ? parsed.message : undefined;
    return message ?? fallback;
  } catch {
    return fallback;
  }
}

export function openAiError(
  _status: number,
  message: string,
  options: OpenAiErrorOptions = {},
): OpenAiErrorBody {
  return {
    error: {
      message,
      type: options.type ?? "invalid_request_error",
      param: options.param ?? null,
      code: options.code ?? null,
    },
  };
}

export function upstreamOpenAiError(status: number, message = "CommandCode upstream request failed") {
  // 保留上游的真实状态码语义：sub2api 之类的池化网关依赖 401/403/429 判断
  // "换账号重试"，把 403（套餐不含该模型）压成 502 会导致整池账号被误判为
  // 上游故障。只有真正无法归类的 4xx 才折叠成 502。
  const passthrough = status === 400
    || status === 401
    || status === 403
    || status === 404
    || status === 408
    || status === 409
    || status === 429
    || status >= 500;
  const effectiveStatus = passthrough ? status : 502;
  const type: OpenAiErrorType = effectiveStatus === 401 || effectiveStatus === 403
    ? "authentication_error"
    : effectiveStatus === 429
      ? "rate_limit_error"
      : effectiveStatus === 400 || effectiveStatus === 404 || effectiveStatus === 409
        ? "invalid_request_error"
        : "api_error";
  return {
    status: effectiveStatus,
    body: openAiError(effectiveStatus, message, {
      type,
      code: effectiveStatus === 401 || effectiveStatus === 403
        ? "upstream_authentication"
        : effectiveStatus === 429
          ? "upstream_rate_limit"
          : effectiveStatus === 400
            ? "upstream_invalid_request"
            : "upstream_error",
    }),
  };
}
