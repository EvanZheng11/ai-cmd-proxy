import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import { extractCredential } from "../auth.js";
import {
  CommandCodeUpstreamError,
  type CommandCodeClient,
} from "../commandcode/client.js";
import type { ProxyConfig } from "../config.js";
import { openAiError, upstreamOpenAiError, UpstreamStreamError } from "../errors.js";
import { toCommandCodeGenerateRequest } from "../translate/generate-request.js";
import { toChatRequestFromResponses, toResponse, toResponseEvents } from "../translate/responses.js";
import { parseResponsesRequest } from "../openai/schemas.js";
import { materializeRemoteImages } from "../translate/messages.js";

type ResponsesRouteDependencies = {
  commandCodeClient: CommandCodeClient;
  config: ProxyConfig;
};

function sendError(reply: FastifyReply, status: number, message: string, code: string) {
  return reply.code(status).send(openAiError(status, message, {
    type: status === 401 ? "authentication_error" : "invalid_request_error",
    code,
  }));
}

export async function registerResponses(
  app: FastifyInstance,
  dependencies: ResponsesRouteDependencies,
): Promise<void> {
  app.post("/v1/responses", async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKey = extractCredential(request.headers);
    if (!apiKey) {
      return sendError(reply, 401, "Missing CommandCode API credential", "missing_api_key");
    }

    try {
      const rawBody = parseResponsesRequest(request.body);
      if (rawBody.previous_response_id) {
        return sendError(
          reply,
          400,
          "previous_response_id requires a stateful response store",
          "previous_response_id_unsupported",
        );
      }
      const body = await materializeRemoteImages(toChatRequestFromResponses(request.body));
      const original = request.body as { stream?: boolean };
      const events = dependencies.commandCodeClient.stream({
        apiKey,
        request: toCommandCodeGenerateRequest(body, {
          defaultMaxTokens: dependencies.config.defaultMaxTokens,
        }),
      });

      if (original.stream) {
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
          for await (const chunk of toResponseEvents(bufferedEvents, body.model)) {
            reply.raw.write(chunk);
          }
        } catch (error) {
          if (error instanceof CommandCodeUpstreamError || error instanceof UpstreamStreamError) {
            const mapped = upstreamOpenAiError(error.status);
            reply.raw.write(`event: error\ndata: ${JSON.stringify(mapped.body)}\n\n`);
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
      return reply.send(toResponse(collected, body.model));
    } catch (error) {
      if (error instanceof CommandCodeUpstreamError) {
        const mapped = upstreamOpenAiError(error.status);
        return reply.code(mapped.status).send(mapped.body);
      }
      if (error instanceof UpstreamStreamError) {
        const mapped = upstreamOpenAiError(error.status);
        return reply.code(mapped.status).send(mapped.body);
      }
      if (error instanceof ZodError || error instanceof Error) {
        return sendError(reply, 400, error instanceof ZodError
          ? error.issues[0]?.message ?? "Invalid request"
          : error.message, "invalid_request");
      }
      throw error;
    }
  });
}
