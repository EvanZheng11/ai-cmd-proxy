import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import { extractCredential } from "../auth.js";
import {
  CommandCodeUpstreamError,
  type CommandCodeClient,
} from "../commandcode/client.js";
import type { ProxyConfig } from "../config.js";
import { openAiError, upstreamOpenAiError, UpstreamStreamError } from "../errors.js";
import { parseChatCompletionRequest } from "../openai/schemas.js";
import { toCommandCodeGenerateRequest } from "../translate/generate-request.js";
import { materializeRemoteImages } from "../translate/messages.js";
import { toChatCompletion, toChatCompletionChunks } from "../translate/chat.js";

type ChatRouteDependencies = {
  commandCodeClient: CommandCodeClient;
  config: ProxyConfig;
};

function sendError(reply: FastifyReply, status: number, message: string, code: string) {
  return reply.code(status).send(openAiError(status, message, {
    type: status === 401 ? "authentication_error" : "invalid_request_error",
    code,
  }));
}

export async function registerChatCompletions(
  app: FastifyInstance,
  dependencies: ChatRouteDependencies,
): Promise<void> {
  app.post("/v1/chat/completions", async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKey = extractCredential(request.headers);
    if (!apiKey) {
      return sendError(reply, 401, "Missing CommandCode API credential", "missing_api_key");
    }

    let body;
    try {
      body = parseChatCompletionRequest(request.body);
    } catch (error) {
      if (error instanceof ZodError) {
        return sendError(reply, 400, error.issues[0]?.message ?? "Invalid request", "invalid_request");
      }
      throw error;
    }

    try {
      const hydratedBody = await materializeRemoteImages(body);
      const commandRequest = toCommandCodeGenerateRequest(hydratedBody, {
        defaultMaxTokens: dependencies.config.defaultMaxTokens,
      });
      const events = dependencies.commandCodeClient.stream({
        apiKey,
        request: commandRequest,
      });

      if (body.stream) {
        // Read the first upstream result before committing the HTTP status.
        // A rejected iterator means CommandCode returned an HTTP/transport error.
        const iterator = events[Symbol.asyncIterator]();
        const first = await iterator.next();
        const bufferedEvents = (async function* () {
          try {
            if (first.done) {
              return;
            }
            yield first.value;
            while (true) {
              const next = await iterator.next();
              if (next.done) {
                return;
              }
              yield next.value;
            }
          } finally {
            await iterator.return?.();
          }
        })();

        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });

        try {
          for await (const chunk of toChatCompletionChunks(bufferedEvents, body)) {
            reply.raw.write(chunk);
          }
        } catch (error) {
          if (error instanceof CommandCodeUpstreamError || error instanceof UpstreamStreamError) {
            const mapped = upstreamOpenAiError(error.status);
            reply.raw.write(`data: ${JSON.stringify(mapped.body)}\n\n`);
            reply.raw.write("data: [DONE]\n\n");
          } else {
            throw error;
          }
        } finally {
          reply.raw.end();
        }
        return;
      }

      const collected = [];
      for await (const event of events) {
        collected.push(event);
      }
      return reply.send(toChatCompletion(collected, body));
    } catch (error) {
      if (error instanceof CommandCodeUpstreamError || error instanceof UpstreamStreamError) {
        const mapped = upstreamOpenAiError(error.status);
        return reply.code(mapped.status).send(mapped.body);
      }
      if (error instanceof Error) {
        return sendError(reply, 400, error.message, "invalid_request");
      }
      throw error;
    }
  });
}
