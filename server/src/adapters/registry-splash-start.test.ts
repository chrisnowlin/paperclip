import { beforeEach, describe, expect, it, vi } from "vitest";

const { start, requireReady, execute } = vi.hoisted(() => ({
  start: vi.fn(), requireReady: vi.fn(), execute: vi.fn(),
}));

vi.mock("../services/splash-runtime.js", () => ({
  appOwnedSplashRuntime: { start, requireReady },
}));
vi.mock("@paperclipai/adapter-lmstudio-splash-local/server", () => ({
  execute, testEnvironment: vi.fn(), getConfigSchema: vi.fn(),
}));

import { requireServerAdapter } from "./registry.js";

describe("app-owned Splash dispatch", () => {
  beforeEach(() => {
    start.mockReset();
    requireReady.mockReset().mockResolvedValue(undefined);
    execute.mockReset();
  });

  it("starts the app-owned model on a local task wake before invoking its adapter", async () => {
    start.mockResolvedValue({ state: "ready" });
    execute.mockResolvedValue({ exitCode: 0 });
    const ctx = { runId: "local-run" } as Parameters<NonNullable<ReturnType<typeof requireServerAdapter>["execute"]>>[0];
    await expect(requireServerAdapter("lmstudio_splash_local").execute(ctx)).resolves.toEqual({ exitCode: 0 });
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]!);
    expect(execute).toHaveBeenCalledWith(ctx);
  });

  it("fails closed when startup fails and never calls another adapter", async () => {
    start.mockRejectedValue(new Error("cached model unavailable"));
    await expect(requireServerAdapter("lmstudio_splash_local").execute({} as never))
      .rejects.toThrow("cached model unavailable");
    expect(execute).not.toHaveBeenCalled();
  });

  it("shows an unloaded model as an on-demand warning without starting it for a settings probe", async () => {
    requireReady.mockRejectedValue(new Error("Bundled Splash is unloaded."));
    const result = await requireServerAdapter("lmstudio_splash_local").testEnvironment!({
      adapterType: "lmstudio_splash_local",
    } as never);
    expect(result.status).toBe("warn");
    expect(result.checks).toEqual([expect.objectContaining({ code: "splash_not_started", level: "warn" })]);
    expect(start).not.toHaveBeenCalled();
  });
});
