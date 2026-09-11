import { describe, expect, it } from "vitest";

import { toChatCompletion } from "../src/translate/chat.js";
import { toResponse } from "../src/translate/responses.js";
import type { CommandCodeEvent } from "../src/commandcode/types.js";

// 上游在 finish 事件里回传的用量形状（取自 alpha/generate 的真实响应）。
// 缓存命中量同时出现在 cachedInputTokens 与 inputTokenDetails.cacheReadTokens。
function finishEvent(totalUsage: Record<string, unknown>): CommandCodeEvent {
  return { type: "finish", finishReason: "stop", totalUsage } as CommandCodeEvent;
}

describe("cached token reporting", () => {
  it("exposes cached_tokens on Chat Completions usage", () => {
    const completion = toChatCompletion(
      [
        { type: "text-delta", text: "hello" } as CommandCodeEvent,
        finishEvent({
          inputTokens: 4367,
          outputTokens: 12,
          cachedInputTokens: 4224,
          inputTokenDetails: { noCacheTokens: 143, cacheReadTokens: 4224 },
        }),
      ],
      { model: "deepseek/deepseek-v4-flash" },
    );

    expect(completion.usage).toEqual({
      prompt_tokens: 4367,
      completion_tokens: 12,
      total_tokens: 4379,
      prompt_tokens_details: { cached_tokens: 4224 },
    });
  });

  it("falls back to the nested cache read field", () => {
    const completion = toChatCompletion(
      [
        finishEvent({
          inputTokens: 100,
          outputTokens: 5,
          inputTokenDetails: { cacheReadTokens: 64 },
        }),
      ],
      { model: "deepseek/deepseek-v4-flash" },
    );

    expect(completion.usage?.prompt_tokens_details.cached_tokens).toBe(64);
  });

  it("reports zero cached tokens when the upstream omits cache details", () => {
    const completion = toChatCompletion(
      [finishEvent({ inputTokens: 41, outputTokens: 3 })],
      { model: "deepseek/deepseek-v4-flash" },
    );

    expect(completion.usage?.prompt_tokens_details).toEqual({ cached_tokens: 0 });
  });

  it("exposes cached_tokens on Responses usage", () => {
    const response = toResponse(
      [
        { type: "text-delta", text: "hello" } as CommandCodeEvent,
        finishEvent({
          inputTokens: 4367,
          outputTokens: 12,
          cachedInputTokens: 4224,
        }),
      ],
      "deepseek/deepseek-v4-flash",
    );

    expect(response.usage).toEqual({
      input_tokens: 4367,
      output_tokens: 12,
      total_tokens: 4379,
      input_tokens_details: { cached_tokens: 4224 },
    });
  });

  it("keeps prompt tokens inclusive of cached tokens", () => {
    // 上游的 inputTokens 已包含命中缓存的 token，不能再叠加 cached，
    // 否则下游会看到被重复计费的 prompt_tokens。
    const completion = toChatCompletion(
      [
        finishEvent({
          inputTokens: 1000,
          outputTokens: 10,
          cachedInputTokens: 900,
        }),
      ],
      { model: "deepseek/deepseek-v4-flash" },
    );

    expect(completion.usage?.prompt_tokens).toBe(1000);
    expect(completion.usage?.total_tokens).toBe(1010);
  });
});
