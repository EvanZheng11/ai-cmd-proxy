import Fastify, { type FastifyInstance } from "fastify";

import type { CommandCodeClient } from "./commandcode/client.js";
import { loadConfig, type ProxyConfig } from "./config.js";
import { registerChatCompletions } from "./routes/chat-completions.js";
import { registerHealth } from "./routes/health.js";
import { registerModels } from "./routes/models.js";
import { registerResponses } from "./routes/responses.js";
import { openAiError } from "./errors.js";

export type ServerDependencies = {
  commandCodeClient: CommandCodeClient;
  config?: ProxyConfig;
};

export function buildServer(dependencies: ServerDependencies): FastifyInstance {
  const config = dependencies.config ?? loadConfig(process.env);
  const app = Fastify({
    logger: false,
    bodyLimit: config.maxRequestBytes,
  });

  void registerChatCompletions(app, { ...dependencies, config });
  void registerResponses(app, { ...dependencies, config });
  void registerModels(app);
  void registerHealth(app);

  app.all("/v1/*", async (_request, reply) => {
    return reply.code(501).send(openAiError(501, "This OpenAI API endpoint is not supported by the CommandCode proxy", {
      type: "api_error",
      code: "unsupported_endpoint",
    }));
  });

  return app;
}
