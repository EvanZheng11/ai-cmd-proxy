import type { ZodError } from "zod";

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

// 上游使用 statusCode/status，可能位于顶层或 error 内。
export function eventStatusCode(event: {
  statusCode?: number;
  status?: number;
  error?: string | { statusCode?: number; status?: number };
}): number {
  const nested = typeof event.error === "object" && event.error !== null ? event.error : undefined;
  return [event.statusCode, event.status, nested?.statusCode, nested?.status]
    .find((status): status is number => Number.isInteger(status) && status! >= 400 && status! <= 599) ?? 502;
}

function errorParam(path: readonly PropertyKey[]): string | null {
  return path.reduce<string>((result, part) => typeof part === "number"
    ? `${result}[${part}]` : `${result}${result ? "." : ""}${String(part)}`, "") || null;
}

export function validationError(error: ZodError, input: unknown, prefix: PropertyKey[] = []) {
  const leaves = (issues: ZodError["issues"], parent: PropertyKey[]): ZodError["issues"] => issues.flatMap((issue) => {
    const path = [...parent, ...issue.path];
    return issue.code === "invalid_union"
      ? issue.errors.flatMap((branch) => leaves(branch, path))
      : [{ ...issue, path }];
  });
  const issues = leaves(error.issues, prefix);
  // union 的不匹配分支可能报告不存在的字段，优先指出请求实际提供的字段。
  const supplied = (path: PropertyKey[]) => path.reduce<unknown>((value, key) =>
    value !== null && typeof value === "object" ? (value as Record<PropertyKey, unknown>)[key] : undefined, input) !== undefined;
  issues.sort((a, b) => Number(supplied(b.path)) - Number(supplied(a.path)) || b.path.length - a.path.length);
  return { message: issues[0]?.message ?? "Invalid request", param: errorParam(issues[0]?.path ?? []) };
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
    || (Number.isInteger(status) && status >= 500 && status <= 599);
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
