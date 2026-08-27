import type { OpenAiChatMessage, OpenAiContentPart } from "../openai/types.js";
import type { CommandCodeContentBlock, CommandCodeMessage } from "../commandcode/types.js";

function dataUrlParts(url: string): { mediaType: string; data: string } | undefined {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
  return match ? { mediaType: match[1], data: match[2] } : undefined;
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

    result.push({
      role: message.role === "tool" ? "tool" : message.role,
      content,
    });
  }

  return { messages: result, system: systemParts.filter(Boolean).join("\n\n") };
}
