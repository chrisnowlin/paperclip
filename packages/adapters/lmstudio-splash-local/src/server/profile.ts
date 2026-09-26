import { LMSTUDIO_SPLASH_MODEL } from "./model.js";

export function assertLmStudioSplashConfig(config: Record<string, unknown>): number {
  if (config.model !== undefined && config.model !== LMSTUDIO_SPLASH_MODEL) {
    throw new Error("LM Studio Splash requires the exact qwen3.8-27b-splash model.");
  }
  for (const key of ["baseUrl", "baseURL", "endpoint", "provider", "command", "extraArgs", "args",
    "apiKey", "aiConnection", "managedAiConnection", "OPENAI_API_KEY", "CODEX_HOME"]) {
    if (config[key] !== undefined) throw new Error("LM Studio Splash cannot use an AI Connection, credential, endpoint, or command override.");
  }
  if (config.env !== undefined) {
    if (typeof config.env !== "object" || config.env === null || Array.isArray(config.env)) {
      throw new Error("LM Studio Splash provider environment is invalid.");
    }
    const env = config.env as Record<string, unknown>;
    if (Object.keys(env).some((key) => /^(?:ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|OPENROUTER_|XAI_|GROK_|LMSTUDIO_)/.test(key))) {
      throw new Error("LM Studio Splash cannot inherit a paid provider environment override.");
    }
  }
  const steps = config.maxSteps ?? 20;
  if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 1 || steps > 24) {
    throw new Error("LM Studio Splash maxSteps must be an integer from 1 to 24.");
  }
  return steps;
}
