import type { UIAdapterModule } from "../types";
import { SchemaConfigFields } from "../schema-config-fields";
import { buildLmStudioSplashConfig, parseLmStudioSplashStdoutLine } from "@paperclipai/adapter-lmstudio-splash-local/ui";

export const lmStudioSplashLocalUIAdapter: UIAdapterModule = {
  type: "lmstudio_splash_local",
  label: "Splash (app-managed)",
  parseStdoutLine: parseLmStudioSplashStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildLmStudioSplashConfig,
};
