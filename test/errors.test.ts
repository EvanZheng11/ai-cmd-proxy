import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { openAiError } from "../src/errors.js";

describe("proxy configuration", () => {
  it("uses a one million token default", () => {
    expect(loadConfig({}).defaultMaxTokens).toBe(1_000_000);
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
