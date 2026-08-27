import type { ChatCompletionRequest, OpenAiChatMessage, OpenAiContentPart } from "../openai/types.js";
import type { CommandCodeContentBlock, CommandCodeMessage } from "../commandcode/types.js";

function dataUrlParts(url: string): { mediaType: string; data: string } | undefined {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
  return match ? { mediaType: match[1], data: match[2] } : undefined;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.endsWith(".localhost")) {
    return true;
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) {
    return true;
  }
  const ipv4 = host.match(/^172\.(\d+)\./);
  return Boolean(ipv4 && Number(ipv4[1]) >= 16 && Number(ipv4[1]) <= 31);
}

export async function materializeRemoteImages(
  request: ChatCompletionRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatCompletionRequest> {
  const messages = await Promise.all(request.messages.map(async (message) => {
    if (!Array.isArray(message.content)) {
      return message;
    }

    const content = await Promise.all(message.content.map(async (part) => {
      if (part.type !== "image_url" || dataUrlParts(part.image_url.url)) {
        return part;
      }

      const url = new URL(part.image_url.url);
      if (!["http:", "https:"].includes(url.protocol) || isPrivateHost(url.hostname)) {
        throw new Error("Only public HTTP(S) image URLs are supported");
      }

      const response = await fetchImpl(url.toString(), {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`Image URL returned HTTP ${response.status}`);
      }

      const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim();
      if (!mediaType?.startsWith("image/")) {
        throw new Error("Image URL did not return an image content type");
      }

      const data = Buffer.from(await response.arrayBuffer()).toString("base64");
      return {
        type: "image_url" as const,
        image_url: {
          ...part.image_url,
          url: `data:${mediaType};base64,${data}`,
        },
      };
    }));

    return { ...message, content };
  }));

  return { ...request, messages };
}

function toContent(content: string | OpenAiContentPart[] | null | undefined): CommandCodeContentBlock[] {
  if (content === null || content === undefined) {
    return [];
  }

  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }

    const image = dataUrlParts(part.image_url.url);
    if (!image) {
      throw new Error("Only base64 data URL images are supported by the synchronous translator");
    }

    return {
      type: "image",
      media_type: image.mediaType,
      data: image.data,
    };
  });
}

export function toCommandCodeMessages(messages: OpenAiChatMessage[]): {
  messages: CommandCodeMessage[];
  system: string;
} {
  const systemParts: string[] = [];
  const result: CommandCodeMessage[] = [];
  const toolNames = new Map<string, string>();

  for (const message of messages) {
    const content = toContent(message.content);
    if (message.role === "system" || message.role === "developer") {
      systemParts.push(
        content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      );
      continue;
    }

    if (message.role === "assistant" && message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        toolNames.set(toolCall.id, toolCall.function.name);
        let input: unknown = toolCall.function.arguments;
        try {
          input = JSON.parse(toolCall.function.arguments);
        } catch {
          // Keep non-JSON arguments as a string for the upstream validator.
        }
        content.push({
          type: "tool-call",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          input,
        });
      }
    }

    if (message.role === "tool") {
      content.splice(0, content.length, {
        type: "tool-result",
        toolCallId: message.tool_call_id ?? "",
        toolName: toolNames.get(message.tool_call_id ?? "") ?? "unknown",
        output: typeof message.content === "string" ? message.content : content,
      });
    }

    result.push({
      role: message.role === "tool" ? "tool" : message.role,
      content,
    });
  }

  return { messages: result, system: systemParts.filter(Boolean).join("\n\n") };
}
