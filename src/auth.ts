type HeaderValue = string | string[] | undefined;

const SENSITIVE_HEADERS = new Set(["authorization", "x-commandcode-api-key"]);

function firstHeaderValue(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

export function extractCredential(headers: Record<string, HeaderValue>): string | undefined {
  const authorization = firstHeaderValue(headers.authorization);
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch?.[1]) {
    return bearerMatch[1].trim();
  }

  return firstHeaderValue(headers["x-commandcode-api-key"])?.trim() || undefined;
}

export function redactHeaders(headers: Record<string, HeaderValue>): Record<string, HeaderValue | "[REDACTED]"> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      SENSITIVE_HEADERS.has(name.toLowerCase()) ? "[REDACTED]" : value,
    ]),
  );
}
