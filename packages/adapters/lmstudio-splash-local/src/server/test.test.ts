import { describe, expect, it, vi } from "vitest";
import { testEnvironment } from "./test.js";

describe("LM Studio Splash setup readiness", () => {
  it("reports a loaded exact Splash model without inference", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ models: [{
      key: "qwen3.8-27b-splash", format: "splash", loaded_instances: [{ id: "loaded-1" }],
    }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const result = await testEnvironment({ companyId: "company-1", adapterType: "lmstudio_splash_local", config: {} });
      expect(result).toMatchObject({ status: "pass", checks: [{ code: "lmstudio_splash_ready", level: "info" }] });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects endpoint and credential overrides before probing", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    try {
      const result = await testEnvironment({ companyId: "company-1", adapterType: "lmstudio_splash_local",
        config: { baseUrl: "https://api.openai.com/v1", env: { OPENAI_API_KEY: "fixture" } } });
      expect(result).toMatchObject({ status: "fail", checks: [{ code: "lmstudio_splash_config_invalid", level: "error" }] });
      expect(fetcher).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
