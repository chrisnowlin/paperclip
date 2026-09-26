import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { LMSTUDIO_SPLASH_MODEL } from "../index.js";

export function buildLmStudioSplashConfig(values: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = { model: LMSTUDIO_SPLASH_MODEL };
  if (values.cwd) config.cwd = values.cwd;
  const maxSteps = values.adapterSchemaValues?.maxSteps;
  if (typeof maxSteps === "number" && Number.isInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 24) {
    config.maxSteps = maxSteps;
  }
  return config;
}
