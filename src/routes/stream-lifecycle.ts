import type { FastifyReply, FastifyRequest } from "fastify";
import { CommandCodeUpstreamError, sanitizeForLog } from "../commandcode/client.js";
import type { CommandCodeEvent } from "../commandcode/types.js";
import { eventStatusCode, upstreamErrorMessage, upstreamOpenAiError, UpstreamStreamError } from "../errors.js";

export function watchDisconnect(reply: FastifyReply) {
  const controller = new AbortController();
  const onClose = () => {
    // request.raw.close 也会在上传正常结束时触发，必须观察响应连接。
    if (!reply.raw.writableFinished) controller.abort(new DOMException("客户端已断开", "AbortError"));
  };
  reply.raw.on("close", onClose);
  if (reply.raw.destroyed) onClose();
  return {
    signal: controller.signal,
    canWrite: () => !reply.raw.destroyed && !reply.raw.writableEnded,
    cleanup: () => reply.raw.off("close", onClose),
  };
}

export async function preRead(iterator: AsyncIterator<CommandCodeEvent>): Promise<IteratorResult<CommandCodeEvent>> {
  while (true) {
    const next = await iterator.next();
    if (next.done) return next;
    const event = next.value;
    if (event.type === "error" || event.type === "abort") {
      throw new UpstreamStreamError(typeof event.error === "string"
        ? event.error : event.error?.message ?? "CommandCode stream aborted", eventStatusCode(event));
    }
    // 不等待第二个有效事件，否则会把流式输出变成全量缓冲。
    if (event.type === "tool-call" || event.type === "finish"
      || ((event.type === "text-delta" || event.type === "reasoning-delta") && event.text)) return next;
  }
}

// iterator 的所有权在路由：包含预读失败在内，均由路由 finally 归还。
export async function* remainingEvents(
  iterator: AsyncIterator<CommandCodeEvent>,
  first?: IteratorResult<CommandCodeEvent>,
): AsyncIterable<CommandCodeEvent> {
  let next = first ?? await iterator.next();
  while (!next.done) {
    yield next.value;
    next = await iterator.next();
  }
}

export function streamError(error: unknown) {
  if (error instanceof CommandCodeUpstreamError || error instanceof UpstreamStreamError) {
    return upstreamOpenAiError(error.status, upstreamErrorMessage(
      error instanceof CommandCodeUpstreamError ? error.body : undefined, error.message,
    ));
  }
  return upstreamOpenAiError(502, "CommandCode stream failed");
}

export function logRouteError(request: FastifyRequest, error: unknown, apiKey: string, message: string): void {
  request.log.error(sanitizeForLog({
    requestId: request.id,
    error: error instanceof SyntaxError ? "响应解析失败" : error instanceof Error ? error.message : "未知错误",
    errorType: error instanceof Error ? error.name : "UnknownError",
    status: error instanceof CommandCodeUpstreamError || error instanceof UpstreamStreamError ? error.status : undefined,
  }, "", [apiKey]), message);
}
