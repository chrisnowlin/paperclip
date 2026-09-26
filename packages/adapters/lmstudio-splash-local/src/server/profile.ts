import { LMSTUDIO_SPLASH_MODEL } from "./model.js";

export function assertLmStudioSplashConfig(config: Record<string, unknown>): number {
  if (config.model !== undefined && config.model !== LMSTUDIO_SPLASH_MODEL) {
    throw new Error("LM Studio Splash requires the exact qwen3.8-27b-splash model.");
  }
  for (const key of ["baseUrl", "baseURL", "endpoint", "provider", "command", "extraArgs", "args",
    "apiKey", "aiConnection", "managedAiConnection", "OPENAI_API_KEY", "CODEX_HOME"]) {
    if (config[key] !== undefined) throw new Error("LM Studio Splash cannot use an AI Connection, credential, endpoint, or command override.");
  }
  if (config.env && (typeof config.env !== "object" || Array.isArray(config.env) || Object.keys(config.env).length > 0)) {
    throw new Error("LM Studio Splash cannot inherit provider environment overrides.");
  }
  const steps = config.maxSteps ?? 20;
  if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 1 || steps > 24) {
    throw new Error("LM Studio Splash maxSteps must be an integer from 1 to 24.");
  }
  return steps;
}
