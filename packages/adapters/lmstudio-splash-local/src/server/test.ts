import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { probeLmStudioSplash } from "./model.js";
import { assertLmStudioSplashConfig } from "./profile.js";

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const testedAt = new Date().toISOString();
  try {
    assertLmStudioSplashConfig(ctx.config);
    if (ctx.executionTarget?.kind === "remote") throw new Error("LM Studio Splash is local-only.");
  } catch (error) {
    return { adapterType: ctx.adapterType, status: "fail", testedAt, checks: [{
      code: "lmstudio_splash_config_invalid", level: "error", message: error instanceof Error ? error.message : "Invalid local model route.",
    }] };
  }
  try {
    await probeLmStudioSplash();
    return { adapterType: ctx.adapterType, status: "pass", testedAt, checks: [{
      code: "lmstudio_splash_ready", level: "info", message: "The exact Splash-format model is loaded in LM Studio.",
    }] };
  } catch (error) {
    return { adapterType: ctx.adapterType, status: "fail", testedAt, checks: [{
      code: "lmstudio_splash_unavailable", level: "error", message: error instanceof Error ? error.message : "LM Studio Splash is unavailable.",
      hint: "Load qwen3.8-27b-splash in LM Studio before assigning work.",
    }] };
  }
}
