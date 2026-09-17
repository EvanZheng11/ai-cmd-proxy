import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { ChatCompletionRequest, OpenAiChatMessage, OpenAiContentPart } from "../openai/types.js";
import type { CommandCodeContentBlock, CommandCodeMessage } from "../commandcode/types.js";

function dataUrlParts(url: string): { mediaType: string; data: string } | undefined {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/s);
  return match ? { mediaType: match[1], data: match[2] } : undefined;
}

type ResolvedAddress = {
  address: string;
  family: number;
};

type ImageMaterializeOptions = {
  maxBytes?: number;
  resolveHost?: (hostname: string) => Promise<ResolvedAddress[]>;
};

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host === "::" || host.endsWith(".localhost")) {
    return true;
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) {
    return true;
  }
  const ipv4 = host.match(/^172\.(\d+)\./);
  if (ipv4 && Number(ipv4[1]) >= 16 && Number(ipv4[1]) <= 31) {
    return true;
  }

  if (isIP(host) === 6) {
    if (/^(fc|fd)/i.test(host) || /^fe[89ab]/i.test(host) || /^ff/i.test(host)) {
      return true;
    }
    const mappedIpv4 = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    return mappedIpv4 ? isPrivateHost(mappedIpv4[1]) : false;
  }

  return false;
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    throw new Error("Image response is too large");
  }
  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Image response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function materializeRemoteImages(
  request: ChatCompletionRequest,
  fetchImpl: typeof fetch = fetch,
  options: ImageMaterializeOptions = {},
): Promise<ChatCompletionRequest> {
  const maxBytes = options.maxBytes ?? 10_485_760;
  const resolveHost = options.resolveHost
    ?? (async (hostname: string) => lookup(hostname, { all: true, verbatim: true }));
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
      const addresses = await resolveHost(url.hostname);
      if (addresses.length === 0 || addresses.some((address) => isPrivateHost(address.address))) {
        throw new Error("Only public HTTP(S) image URLs are supported");
      }

      const response = await fetchImpl(url.toString(), {
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
      if (!response.ok) {
        throw new Error(`Image URL returned HTTP ${response.status}`);
      }

      const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim();
      if (!mediaType?.startsWith("image/")) {
        throw new Error("Image URL did not return an image content type");
      }

      const data = Buffer.from(await readLimitedBody(response, maxBytes)).toString("base64");
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
      image: `data:${image.mediaType};base64,${image.data}`,
      mediaType: image.mediaType,
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
    if (message.role === "assistant" && message.reasoning_content) {
      content.unshift({ type: "reasoning", text: message.reasoning_content });
    }
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
        output: {
          type: "text",
          value: typeof message.content === "string" ? message.content : JSON.stringify(content),
        },
      });
    }

    result.push({
      role: message.role === "tool" ? "tool" : message.role,
      content,
    });
  }

  return { messages: result, system: systemParts.join("\n\n") };
}
