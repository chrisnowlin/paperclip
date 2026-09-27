import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { probeLmStudioSplash } from "./model.js";
import { assertLmStudioSplashConfig } from "./profile.js";

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const testedAt = new Date().toISOString();
  try {
    assertLmStudioSplashConfig(ctx.config);
    if (ctx.executionTarget?.kind === "remote") throw new Error("App-managed Splash is local-only.");
  } catch (error) {
    return { adapterType: ctx.adapterType, status: "fail", testedAt, checks: [{
      code: "lmstudio_splash_config_invalid", level: "error", message: error instanceof Error ? error.message : "Invalid local model route.",
    }] };
  }
  try {
    await probeLmStudioSplash();
    return { adapterType: ctx.adapterType, status: "pass", testedAt, checks: [{
      code: "lmstudio_splash_ready", level: "info", message: "Paperclip's bundled Splash server is ready with the exact Qwen model.",
    }] };
  } catch (error) {
    return { adapterType: ctx.adapterType, status: "fail", testedAt, checks: [{
      code: "lmstudio_splash_unavailable", level: "error", message: error instanceof Error ? error.message : "App-managed Splash is unavailable.",
      hint: "Use Start Splash in Paperclip before assigning work.",
    }] };
  }
}
