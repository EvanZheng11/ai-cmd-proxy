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
  const type: OpenAiErrorType = status === 401
    ? "authentication_error"
    : status === 429
      ? "rate_limit_error"
      : "api_error";
  return {
    status: status === 401 || status === 429 || status >= 500 ? status : 502,
    body: openAiError(status, message, {
      type,
      code: status === 401
        ? "upstream_authentication"
        : status === 429
          ? "upstream_rate_limit"
          : "upstream_error",
    }),
  };
}
