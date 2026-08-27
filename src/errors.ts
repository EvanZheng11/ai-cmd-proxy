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
