import { describe, expect, it } from "vitest";

import { redactHeaders } from "../src/auth.js";

describe("credential safety", () => {
  it("redacts authorization values regardless of header casing", () => {
    expect(redactHeaders({
      Authorization: "Bearer secret-value",
      "X-CommandCode-Api-Key": "secret-value",
      accept: "application/json",
    })).toEqual({
      Authorization: "[REDACTED]",
      "X-CommandCode-Api-Key": "[REDACTED]",
      accept: "application/json",
    });
  });
});
