import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { openAiError } from "../src/errors.js";

describe("proxy configuration", () => {
  it("uses an upstream-safe default token cap", () => {
    // 上游 params.max_tokens 上限为 200000，默认值必须落在上限内。
    expect(loadConfig({}).defaultMaxTokens).toBe(32_000);
  });
});

describe("openAiError", () => {
  it("returns the OpenAI error envelope", () => {
    expect(openAiError(400, "Bad input", { code: "invalid_input" })).toEqual({
      error: {
        message: "Bad input",
        type: "invalid_request_error",
        param: null,
        code: "invalid_input",
      },
    });
  });
});
