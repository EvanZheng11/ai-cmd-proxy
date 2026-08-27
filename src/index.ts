import { loadConfig } from "./config.js";

export async function start(): Promise<void> {
  const config = loadConfig(process.env);
  process.stdout.write(`ai-cmd-proxy is not configured yet on ${config.host}:${config.port}\n`);
}

if (import.meta.main) {
  await start();
}
