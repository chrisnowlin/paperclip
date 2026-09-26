import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";
import { assertLocalSplashCliOverridesAbsent, assertLocalSplashReady, SPLASH_MODEL } from "./splash.js";

describe("explicit local Splash routing", () => {
  it("isolates paid accounts and pins every OpenCode call to Splash", async () => {
    const prepared = await prepareOpenCodeRuntimeConfig({
      env: { OPENAI_API_KEY: "paid-key", ANTHROPIC_API_KEY: "other-key", OPENCODE_AUTH_JSON: "secret" },
      config: { localSplash: true, model: SPLASH_MODEL },
    });
    try {
      expect(prepared.env.OPENAI_API_KEY).toBe("");
      expect(prepared.env.ANTHROPIC_API_KEY).toBe("");
      expect(prepared.env.OPENCODE_AUTH_JSON).toBe("");
      expect(prepared.env.XDG_DATA_HOME).toBe(path.join(prepared.env.XDG_CONFIG_HOME, "data"));
      const config = JSON.parse(await fs.readFile(path.join(prepared.env.XDG_CONFIG_HOME, "opencode/opencode.json"), "utf8"));
      expect(config).toMatchObject({
        model: SPLASH_MODEL,
        small_model: SPLASH_MODEL,
        provider: { splash: { options: { baseURL: "http://127.0.0.1:8000/v1" } } },
      });
      expect(config.provider).toHaveProperty("splash");
      expect(Object.keys(config.provider)).toEqual(["splash"]);
      expect(Object.values(config.agent).every((agent: unknown) =>
        agent && typeof agent === "object" && "model" in agent && agent.model === SPLASH_MODEL)).toBe(true);
    } finally { await prepared.cleanup(); }
    await expect(fs.access(prepared.env.XDG_CONFIG_HOME)).rejects.toThrow();
  });

  it("rejects a paid model or remote target instead of falling back", async () => {
    await expect(prepareOpenCodeRuntimeConfig({ env: {}, config: { localSplash: true, model: "openai/gpt-5" } })).rejects.toThrow("explicit model");
    await expect(prepareOpenCodeRuntimeConfig({ env: {}, config: { localSplash: true, model: SPLASH_MODEL }, targetIsRemote: true })).rejects.toThrow("local execution");
  });

  it("requires the selected model on the loopback endpoint", async () => {
    const ready = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "incoai/Qwen3.8-27B-Splash" }] }), { status: 200 }));
    await assertLocalSplashReady(SPLASH_MODEL, ready);
    expect(ready).toHaveBeenCalledWith("http://127.0.0.1:8000/v1/models", expect.objectContaining({ redirect: "error" }));
    await expect(assertLocalSplashReady(SPLASH_MODEL, vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")))).rejects.toThrow("not ready");
    await expect(assertLocalSplashReady(SPLASH_MODEL, vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "other" }] }))))).rejects.toThrow("not ready");
    await expect(assertLocalSplashReady("openai/gpt-5", ready)).rejects.toThrow("requires");
  });

  it("retains a task's isolated OpenCode session data across invocations", async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "paperclip-splash-state-test-"));
    vi.stubEnv("PAPERCLIP_HOME", root);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "v2-test");
    const input = { env: {}, config: { localSplash: true, model: SPLASH_MODEL },
      splashSessionIdentity: { companyId: "company-1", agentId: "agent-1", taskId: "task-1" } };
    try {
      const first = await prepareOpenCodeRuntimeConfig(input);
      expect(first.env.XDG_DATA_HOME.startsWith(path.join(root, "instances", "v2-test", "local-splash"))).toBe(true);
      await fs.mkdir(first.env.XDG_DATA_HOME, { recursive: true });
      await fs.writeFile(path.join(first.env.XDG_DATA_HOME, "session-marker"), "saved session");
      await first.cleanup();
      const second = await prepareOpenCodeRuntimeConfig(input);
      expect(second.env.XDG_DATA_HOME).toBe(first.env.XDG_DATA_HOME);
      expect(second.env.XDG_CONFIG_HOME).not.toBe(first.env.XDG_CONFIG_HOME);
      expect(await fs.readFile(path.join(second.env.XDG_DATA_HOME, "session-marker"), "utf8")).toBe("saved session");
      await second.cleanup();
      const otherTask = await prepareOpenCodeRuntimeConfig({ ...input,
        splashSessionIdentity: { ...input.splashSessionIdentity, taskId: "task-2" } });
      expect(otherTask.env.XDG_DATA_HOME).not.toBe(first.env.XDG_DATA_HOME);
      await otherTask.cleanup();
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects extra OpenCode arguments that could override the Splash route", () => {
    expect(() => assertLocalSplashCliOverridesAbsent({ extraArgs: ["--model", "openai/gpt-5"] })).toThrow("extra arguments");
    expect(() => assertLocalSplashCliOverridesAbsent({ args: ["--attach", "http://localhost:4096"] })).toThrow("extra arguments");
    expect(() => assertLocalSplashCliOverridesAbsent({})).not.toThrow();
  });
});
