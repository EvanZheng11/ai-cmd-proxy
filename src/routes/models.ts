import type { FastifyInstance } from "fastify";

const MODELS = [
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "moonshotai/kimi-k3",
  "zai-org/glm-5.2",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "claude-sonnet-5",
];

export async function registerModels(app: FastifyInstance): Promise<void> {
  app.get("/v1/models", async () => ({
    object: "list",
    data: MODELS.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "commandcode",
    })),
  }));
}
