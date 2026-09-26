import type { UIAdapterModule } from "../types";
import { SchemaConfigFields } from "../schema-config-fields";
import { buildLmStudioSplashConfig, parseLmStudioSplashStdoutLine } from "@paperclipai/adapter-lmstudio-splash-local/ui";

export const lmStudioSplashLocalUIAdapter: UIAdapterModule = {
  type: "lmstudio_splash_local",
  label: "LM Studio Splash (local)",
  parseStdoutLine: parseLmStudioSplashStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildLmStudioSplashConfig,
};
