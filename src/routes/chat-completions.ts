import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import { extractCredential } from "../auth.js";
import type { CommandCodeClient } from "../commandcode/client.js";
import { openAiError } from "../errors.js";
import { parseChatCompletionRequest } from "../openai/schemas.js";
import { toCommandCodeGenerateRequest } from "../translate/generate-request.js";
import { toChatCompletion, toChatCompletionChunks } from "../translate/chat.js";

type ChatRouteDependencies = {
  commandCodeClient: CommandCodeClient;
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

    const commandRequest = toCommandCodeGenerateRequest(body);
    const events = dependencies.commandCodeClient.stream({
      apiKey,
      request: commandRequest,
    });

    if (body.stream) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      try {
        for await (const chunk of toChatCompletionChunks(events, body)) {
          reply.raw.write(chunk);
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
  });
}
