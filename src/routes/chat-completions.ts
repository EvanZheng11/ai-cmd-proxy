import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import { extractCredential } from "../auth.js";
import { CommandCodeUpstreamError, sanitizeForLog, type CommandCodeClient } from "../commandcode/client.js";
import type { CommandCodeEvent } from "../commandcode/types.js";
import type { ProxyConfig } from "../config.js";
import { openAiError, validationError, UpstreamStreamError } from "../errors.js";
import { parseChatCompletionRequest } from "../openai/schemas.js";
import { toCommandCodeGenerateRequest } from "../translate/generate-request.js";
import { materializeRemoteImages } from "../translate/messages.js";
import { toChatCompletion, toChatCompletionChunks } from "../translate/chat.js";
import { logRouteError, preRead, remainingEvents, streamError, watchDisconnect } from "./stream-lifecycle.js";

type ChatRouteDependencies = {
  commandCodeClient: CommandCodeClient;
  config: ProxyConfig;
};

function sendError(reply: FastifyReply, status: number, message: string, code: string, param: string | null = null) {
  return reply.code(status).send(openAiError(status, message, {
    type: status === 401 ? "authentication_error" : "invalid_request_error",
    code,
    param,
  }));
}

export async function registerChatCompletions(app: FastifyInstance, dependencies: ChatRouteDependencies): Promise<void> {
  app.post("/v1/chat/completions", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("x-request-id", request.id);
    const apiKey = extractCredential(request.headers);
    if (!apiKey) return sendError(reply, 401, "Missing CommandCode API credential", "missing_api_key");

    const lifecycle = watchDisconnect(reply);
    let iterator: AsyncIterator<CommandCodeEvent> | undefined;
    try {
      const body = parseChatCompletionRequest(request.body);
      const hydratedBody = await materializeRemoteImages(body);
      if (!lifecycle.canWrite()) return;
      request.log.info(sanitizeForLog({ requestId: request.id, model: body.model, stream: !!body.stream }, "", [apiKey]), "CommandCode Chat 请求开始");
      iterator = dependencies.commandCodeClient.stream({
        apiKey,
        requestId: request.id,
        signal: lifecycle.signal,
        request: toCommandCodeGenerateRequest(hydratedBody, { defaultMaxTokens: dependencies.config.defaultMaxTokens }),
      })[Symbol.asyncIterator]();

      if (body.stream) {
        const first = await preRead(iterator);
        if (!lifecycle.canWrite()) return;
        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-request-id": request.id,
        });
        try {
          for await (const chunk of toChatCompletionChunks(remainingEvents(iterator, first), body)) {
            if (!lifecycle.canWrite()) break;
            reply.raw.write(chunk);
          }
        } catch (error) {
          logRouteError(request, error, apiKey, "CommandCode Chat 流式处理失败");
          if (lifecycle.canWrite()) {
            const mapped = streamError(error);
            reply.raw.write(`data: ${JSON.stringify(mapped.body)}\n\n`);
            reply.raw.write("data: [DONE]\n\n");
          }
        } finally {
          if (lifecycle.canWrite()) reply.raw.end();
        }
        return;
      }

      const collected = [];
      for await (const event of remainingEvents(iterator)) collected.push(event);
      if (lifecycle.canWrite()) return reply.send(toChatCompletion(collected, body));
    } catch (error) {
      logRouteError(request, error, apiKey, "CommandCode Chat 本地处理失败");
      if (!lifecycle.canWrite()) return;
      if (iterator || error instanceof CommandCodeUpstreamError || error instanceof UpstreamStreamError) {
        const mapped = streamError(error);
        return reply.code(mapped.status).send(mapped.body);
      }
      if (error instanceof ZodError) {
        const detail = validationError(error, request.body);
        return sendError(reply, 400, detail.message, "invalid_request", detail.param);
      }
      if (error instanceof Error) return sendError(reply, 400, error.message, "invalid_request");
      throw error;
    } finally {
      try { await iterator?.return?.(); }
      catch (error) { logRouteError(request, error, apiKey, "CommandCode Chat 流清理失败"); }
      finally { lifecycle.cleanup(); }
    }
  });
}
