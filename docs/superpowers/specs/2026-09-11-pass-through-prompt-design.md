# Pass-Through Prompt Translation

## Goal

Keep user-provided prompt text and message order stable at the proxy boundary so
the upstream provider can reuse input-prefix cache entries. The proxy will
continue adapting the OpenAI protocol to CommandCode's `/alpha/generate`
protocol where required.

## Behavior

- Do not append proxy-generated natural-language instructions to `system`.
- Preserve text content and message order without trimming or normalization.
- Preserve the order of system and developer content when adapting it to the
  upstream `params.system` string, using only a stable separator required by
  the current upstream schema.
- Continue converting tool calls, tool results, tools, and remote images when
  required by the upstream protocol.
- Do not add a prompt-based fallback for structured output. Preserve native
  structured-output fields where supported; unsupported upstream behavior is
  surfaced as an error rather than changing the prompt.
- Keep existing upstream usage and cache-token reporting unchanged.

## Scope

Changes are limited to translation behavior and its tests. No local prompt
cache is introduced, and no unrelated request, response, or authentication
behavior is changed.

## Verification

Tests must prove that structured-output translation does not inject text, that
system/developer text remains stable and ordered, and that existing cache usage
mapping remains intact.
