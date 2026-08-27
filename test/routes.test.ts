import { describe, expect, it } from "vitest";

import type { CommandCodeClient } from "../src/commandcode/client.js";
import { buildServer } from "../src/server.js";

const emptyClient: CommandCodeClient = {
  async *stream() {
    // No upstream events needed for utility routes.
  },
};

describe("utility routes", () => {
  it("lists configured proxy models and reports health", async () => {
    const app = buildServer({ commandCodeClient: emptyClient });

    expect((await app.inject("/healthz")).json()).toEqual({ status: "ok" });
    expect((await app.inject("/v1/models")).json()).toMatchObject({
      object: "list",
    });
  });

  it("returns an OpenAI-shaped error for unsupported API groups", async () => {
    const response = await buildServer({ commandCodeClient: emptyClient }).inject({
      method: "POST",
      url: "/v1/embeddings",
      headers: { authorization: "Bearer request-key" },
      payload: { model: "deepseek/deepseek-v4-flash", input: "Hi" },
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({
      error: { code: "unsupported_endpoint" },
    });
  });
});
