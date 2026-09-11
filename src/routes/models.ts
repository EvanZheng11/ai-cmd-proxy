import type { FastifyInstance } from "fastify";

import type { ProxyConfig } from "../config.js";

type ModelDefinition = {
  id: string;
  name?: string;
  attachment?: boolean;
  modalities?: {
    input: string[];
    output: string[];
  };
};

// 上游 /provider/v1/models 返回账号实际可用的模型清单，但该接口不标注多模态
// 能力。这里只在真实清单基础上补充已知的视觉模型标记，避免把模型名硬编码成
// 一份会过期的静态表。上游 id 大小写不统一（moonshotai/Kimi-K2.5），故匹配时
// 忽略大小写。
//
// 注意：模型是否可用最终取决于 CommandCode 套餐（如 go plan 只放开一部分
// 模型），因此 /v1/models 只作为能力提示，不应据此判定账号可用性。
const VISION_MODELS = new Set([
  "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4-flash-vision-exp",
  "gpt-5.6-luna",
  "minimaxai/minimax-m2.5",
  "minimaxai/minimax-m3",
  "moonshotai/kimi-k2.5",
  "moonshotai/kimi-k3",
  "z-ai/glm-5.3-flash",
  "zai-org/glm-5.2",
  "zai-org/glm-5.3",
]);

function isVisionModel(id: string): boolean {
  return VISION_MODELS.has(id.toLowerCase());
}

// 上游不可达时回退到的最小清单，保证 agent 至少能枚举到常用模型。
const FALLBACK_MODELS: ModelDefinition[] = [
  { id: "deepseek/deepseek-v4-flash" },
  { id: "deepseek/deepseek-v4-pro" },
  { id: "deepseek/deepseek-v4.1-flash", attachment: true },
  { id: "deepseek/deepseek-v4-flash-vision-exp", attachment: true },
  { id: "zai-org/GLM-5.3" },
  { id: "moonshotai/Kimi-K3" },
];

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

type UpstreamModel = {
  id?: unknown;
  name?: unknown;
};

function withCapabilities(model: ModelDefinition): ModelDefinition {
  if (!isVisionModel(model.id)) {
    return model;
  }
  return {
    ...model,
    attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] },
  };
}

async function fetchUpstreamModels(
  config: ProxyConfig,
  apiKey: string | undefined,
): Promise<ModelDefinition[] | undefined> {
  if (!apiKey) {
    return undefined;
  }
  try {
    const url = new URL("/provider/v1/models", config.commandCodeApiUrl).toString();
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "user-agent": "cli",
        "x-command-code-version": config.commandCodeVersion,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return undefined;
    }
    const body = await response.json() as { data?: UpstreamModel[] };
    const models = Array.isArray(body.data) ? body.data : [];
    return models.flatMap<ModelDefinition>((model) => {
      if (typeof model.id !== "string" || !model.id) {
        return [];
      }
      return [{
        id: model.id,
        ...(typeof model.name === "string" ? { name: model.name } : {}),
      }];
    });
  } catch {
    // 模型清单是辅助信息，上游不可达时回退到静态清单，不影响推理转发。
    return undefined;
  }
}

export async function registerModels(
  app: FastifyInstance,
  config?: ProxyConfig,
): Promise<void> {
  const resolvedConfig = config;
  let cache: { expiresAt: number; models: ModelDefinition[] } | undefined;

  app.get("/v1/models", async (request) => {
    if (cache && cache.expiresAt > Date.now()) {
      return toModelsResponse(cache.models);
    }

    const authorization = request.headers.authorization;
    const apiKey = typeof authorization === "string"
      ? authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
      : undefined;

    const upstream = resolvedConfig
      ? await fetchUpstreamModels(resolvedConfig, apiKey)
      : undefined;
    const models = (upstream && upstream.length > 0 ? upstream : FALLBACK_MODELS)
      .map(withCapabilities);

    if (upstream && upstream.length > 0) {
      cache = { expiresAt: Date.now() + MODELS_CACHE_TTL_MS, models };
    }
    return toModelsResponse(models);
  });
}

function toModelsResponse(models: ModelDefinition[]) {
  return {
    object: "list",
    data: models.map((model) => ({
      ...model,
      object: "model",
      created: 0,
      owned_by: "commandcode",
    })),
  };
}
