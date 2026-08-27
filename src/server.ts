import Fastify, { type FastifyInstance } from "fastify";

import type { CommandCodeClient } from "./commandcode/client.js";
import { registerChatCompletions } from "./routes/chat-completions.js";

export type ServerDependencies = {
  commandCodeClient: CommandCodeClient;
};

export function buildServer(dependencies: ServerDependencies): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 20_971_520,
  });

  void registerChatCompletions(app, dependencies);

  return app;
}
