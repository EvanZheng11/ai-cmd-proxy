import { describe, expect, it } from "vitest";

import type { CommandCodeClient } from "../src/commandcode/client.js";
import type { CommandCodeEvent } from "../src/commandcode/types.js";
import { buildServer } from "../src/server.js";
import { toChatRequestFromResponses } from "../src/translate/responses.js";

function fakeClient(events: CommandCodeEvent[]): CommandCodeClient {
  return {
    async *stream() {
      yield* events;
    },
  };
}

describe("POST /v1/responses", () => {
  it("normalizes Responses input_text and input_image parts", () => {
    const result = toChatRequestFromResponses({
      model: "deepseek/deepseek-v4-flash",
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "Describe this" },
          { type: "input_image", image_url: "https://example.com/a.png" },
        ],
      }],
    });

    expect(result.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Describe this" },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ],
    });
  });

  it("returns a Responses API output item", async () => {
    const response = await buildServer({
      commandCodeClient: fakeClient([
        { type: "text-delta", text: "TEST_OK" },
        { type: "finish", finishReason: "end_turn" },
      ]),
    }).inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer request-key" },
      payload: {
        model: "deepseek/deepseek-v4-flash",
        input: "Hi",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "response",
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "TEST_OK" }],
      }],
    });
  });

  it("streams Responses lifecycle events", async () => {
    const response = await buildServer({
      commandCodeClient: fakeClient([
        { type: "text-delta", text: "TEST_OK" },
        { type: "finish", finishReason: "end_turn" },
      ]),
    }).inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer request-key" },
      payload: {
        model: "deepseek/deepseek-v4-flash",
        input: "Hi",
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("response.created");
    expect(response.body).toContain("response.output_text.delta");
    expect(response.body).toContain("response.completed");
  });
});
