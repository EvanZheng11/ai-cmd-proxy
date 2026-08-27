import { describe, expect, it } from "vitest";

import { toCommandCodeGenerateRequest } from "../src/translate/generate-request.js";

describe("OpenAI request translation", () => {
  it("maps text, system instructions, and max completion tokens", () => {
    const result = toCommandCodeGenerateRequest({
      model: "deepseek/deepseek-v4-flash",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" },
      ],
      max_completion_tokens: 123,
    });

    expect(result.mode).toBe("agent");
    expect(result.params.system).toBe("Be concise.");
    expect(result.params.max_tokens).toBe(123);
    expect(result.params.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);
  });

  it("maps image data URLs and function tools", () => {
    const result = toCommandCodeGenerateRequest({
      model: "deepseek/deepseek-v4-flash",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Read this" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aGVsbG8=" },
          },
        ],
      }],
      tools: [{
        type: "function",
        function: {
          name: "lookup",
          description: "Find a record",
          parameters: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      }],
    });

    expect(result.params.messages[0]?.content[1]).toMatchObject({
      type: "image",
      media_type: "image/png",
      data: "aGVsbG8=",
    });
    expect(result.params.tools[0]).toEqual({
      name: "lookup",
      description: "Find a record",
      input_schema: {
        type: "object",
        properties: { id: { type: "string" } },
      },
    });
  });

  it("maps sampling and reasoning controls", () => {
    const result = toCommandCodeGenerateRequest({
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "Think" }],
      max_tokens: 12,
      temperature: 0.2,
      top_p: 0.8,
      stop: ["END"],
      reasoning_effort: "high",
    });

    expect(result.params).toMatchObject({
      max_tokens: 12,
      temperature: 0.2,
      top_p: 0.8,
      stop: ["END"],
      reasoning_effort: "high",
    });
  });
});
