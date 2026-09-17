import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import { extractCredential } from "../auth.js";
import { CommandCodeUpstreamError, sanitizeForLog, type CommandCodeClient } from "../commandcode/client.js";
import type { CommandCodeEvent } from "../commandcode/types.js";
import type { ProxyConfig } from "../config.js";
import { openAiError, validationError, UpstreamStreamError } from "../errors.js";
import { toCommandCodeGenerateRequest } from "../translate/generate-request.js";
import {
  buildResponsesToolNameMap,
  ResponsesTranslationError,
  UnsupportedImageFileIdError,
  toChatRequestFromResponses,
  toResponse,
  toResponseEvents,
} from "../translate/responses.js";
import { parseResponsesRequest } from "../openai/schemas.js";
import { materializeRemoteImages } from "../translate/messages.js";
import { logRouteError, preRead, remainingEvents, streamError, watchDisconnect } from "./stream-lifecycle.js";

type ResponsesRouteDependencies = {
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

export async function registerResponses(app: FastifyInstance, dependencies: ResponsesRouteDependencies): Promise<void> {
  app.post("/v1/responses", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("x-request-id", request.id);
    const apiKey = extractCredential(request.headers);
    if (!apiKey) return sendError(reply, 401, "Missing CommandCode API credential", "missing_api_key");

    const lifecycle = watchDisconnect(reply);
    let iterator: AsyncIterator<CommandCodeEvent> | undefined;
    request.log.info({ requestId: request.id }, "CommandCode Responses 入站请求参数");
    try {
      const original = parseResponsesRequest(request.body);
      const toolNameMap = buildResponsesToolNameMap(original.tools);
      const body = await materializeRemoteImages(toChatRequestFromResponses(original));
      if (!lifecycle.canWrite()) return;
      request.log.info(sanitizeForLog({ requestId: request.id, model: body.model, stream: !!original.stream }, "", [apiKey]), "CommandCode Responses 请求开始");
      iterator = dependencies.commandCodeClient.stream({
        apiKey,
        requestId: request.id,
        signal: lifecycle.signal,
        request: toCommandCodeGenerateRequest(body, { defaultMaxTokens: dependencies.config.defaultMaxTokens }),
      })[Symbol.asyncIterator]();

      if (original.stream) {
        const first = await preRead(iterator);
        if (!lifecycle.canWrite()) return;
        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-request-id": request.id,
        });
        let created: Record<string, unknown> | undefined;
        try {
          for await (const chunk of toResponseEvents(remainingEvents(iterator, first), body.model, { toolNameMap })) {
            if (!lifecycle.canWrite()) break;
            if (chunk.startsWith("event: response.created\n")) {
              created = JSON.parse(chunk.split("\ndata: ")[1]!).response;
            }
            reply.raw.write(chunk);
          }
        } catch (error) {
          logRouteError(request, error, apiKey, "CommandCode Responses 流式处理失败");
          if (lifecycle.canWrite()) {
            const mapped = streamError(error);
            reply.raw.write(`event: response.failed\ndata: ${JSON.stringify({
              type: "response.failed",
              response: { ...created, status: "failed", error: { ...mapped.body.error, status_code: mapped.status } },
            })}\n\n`);
          }
        } finally {
          if (lifecycle.canWrite()) reply.raw.end();
        }
        return;
      }

      const collected = [];
      for await (const event of remainingEvents(iterator)) collected.push(event);
      if (lifecycle.canWrite()) return reply.send(toResponse(collected, body.model, { toolNameMap }));
    } catch (error) {
      logRouteError(request, error, apiKey, "CommandCode Responses 本地处理失败");
      if (!lifecycle.canWrite()) return;
      if (error instanceof ResponsesTranslationError) {
        return sendError(reply, error.statusCode, error.message, error.code, error.param);
      }
      if (error instanceof UnsupportedImageFileIdError) {
        return sendError(reply, 400, error.message, "unsupported_image_file_id");
      }
      if (iterator || error instanceof CommandCodeUpstreamError || error instanceof UpstreamStreamError) {
        const mapped = streamError(error);
        return reply.code(mapped.status).send(mapped.body);
      }
      if (error instanceof ZodError) {
        // parseResponsesTools 单独校验工具数组，其路径尚未带 tools 前缀。
        const path = error.issues[0]?.path ?? [];
        const prefix = typeof path[0] === "number" || (path.length === 0 && request.body !== null
          && typeof request.body === "object" && "tools" in request.body && request.body.tools !== undefined)
          ? ["tools"] : [];
        const detail = validationError(error, request.body, prefix);
        return sendError(reply, 400, detail.message, "invalid_request", detail.param);
      }
      if (error instanceof Error) return sendError(reply, 400, error.message, "invalid_request");
      throw error;
    } finally {
      try { await iterator?.return?.(); }
      catch (error) { logRouteError(request, error, apiKey, "CommandCode Responses 流清理失败"); }
      finally { lifecycle.cleanup(); }
    }
  });
}
