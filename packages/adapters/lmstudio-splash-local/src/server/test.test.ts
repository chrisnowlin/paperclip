import { describe, expect, it, vi } from "vitest";
import { testEnvironment } from "./test.js";

describe("app-owned Splash setup readiness", () => {
  it("reports a loaded exact Splash model without inference", async () => {
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith("/ready") ? { status: "ready" }
        : url.endsWith("/status") ? { maximum_context_tokens: 222_822,
          instance: { model: "incoai/Qwen3.8-27B-Splash", host: "127.0.0.1", port: 3321 } }
          : { data: [{ id: "qwen3.8-27b-splash", root: "incoai/Qwen3.8-27B-Splash", owned_by: "splash" }] },
    ), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const result = await testEnvironment({ companyId: "company-1", adapterType: "lmstudio_splash_local", config: {} });
      expect(result).toMatchObject({ status: "pass", checks: [{ code: "lmstudio_splash_ready", level: "info" }] });
      expect(fetcher).toHaveBeenCalledTimes(3);
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
