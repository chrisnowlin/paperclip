import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AppOwnedSplashRuntime, prepareOfflineSplashAssets, probeAppOwnedSplash } from "./splash-runtime.js";

const GIB = 1024 ** 3;
const ready = (pid = 4812) => ({
  status: { maximum_context_tokens: 222_822, instance: { pid, model: "incoai/Qwen3.8-27B-Splash", host: "127.0.0.1", port: 3321 } },
  models: { data: [
    { id: "incoai/Qwen3.8-27B-Splash", owned_by: "splash" },
    { id: "qwen3.8-27b-splash", root: "incoai/Qwen3.8-27B-Splash", owned_by: "splash" },
  ] },
});

describe("app-owned Splash runtime", () => {
  it("checks the exact child process, package, port, and alias", async () => {
    const fixture = ready();
    const fetcher = vi.fn<typeof fetch>(async (url) => new Response(JSON.stringify(
      String(url).endsWith("/ready") ? { status: "ready" }
        : String(url).endsWith("/status") ? fixture.status : fixture.models,
    )));
    await expect(probeAppOwnedSplash(4812, fetcher)).resolves.toBe(true);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3321/ready", "http://127.0.0.1:3321/status", "http://127.0.0.1:3321/v1/models",
    ]);
    fixture.status.instance.model = "other/model";
    await expect(probeAppOwnedSplash(4812, fetcher)).resolves.toBe(false);
    fixture.status.instance.model = "incoai/Qwen3.8-27B-Splash";
    fixture.models.data[1]!.owned_by = "other";
    await expect(probeAppOwnedSplash(4812, fetcher)).resolves.toBe(false);
  });

  function harness(options: { freeBytes?: number; freeByPath?: Record<string, number>; busy?: boolean; otherModelLoaded?: boolean; portAvailable?: boolean; probe?: (pid: number) => Promise<boolean> } = {}) {
    const child = Object.assign(new EventEmitter(), {
      pid: 4812, exitCode: null as number | null, signalCode: null as string | null,
      stdout: new PassThrough(), stderr: new PassThrough(),
    });
    const spawnProcess = vi.fn((_command: string, _args: string[], _options: SpawnOptions) => child);
    const terminateGroup = vi.fn(async () => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
    });
    const runtime = new AppOwnedSplashRuntime({
      runtimeRoot: "/bundle/splash", instanceRoot: "/paperclip-v2",
      hubCache: "/Users/operator/.cache/huggingface/hub",
      fileExists: async () => true,
      ensureDir: async () => {},
      freeBytes: async (target) => options.freeByPath?.[target] ?? options.freeBytes ?? 8 * GIB,
      otherModelLoaded: async () => options.otherModelLoaded ?? false,
      portAvailable: async () => options.portAvailable ?? true,
      prepareAssets: async () => {},
      spawnProcess: spawnProcess as never,
      terminateGroup,
      probe: options.probe ?? (async () => true),
      wait: async () => {},
      hasActiveRun: () => options.busy ?? false,
    });
    return { runtime, child, spawnProcess, terminateGroup };
  }

  it("starts one bundled offline process and coalesces repeated start requests", async () => {
    const { runtime, spawnProcess } = harness();
    const [first, second] = await Promise.all([runtime.start(), runtime.start()]);
    expect(first.state).toBe("ready");
    expect(second.state).toBe("ready");
    expect(spawnProcess).toHaveBeenCalledOnce();
    const [command, args, options] = spawnProcess.mock.calls[0]!;
    expect(command).toBe("/bundle/splash/python/bin/python3");
    expect(args).toContain("/bundle/splash/install/launcher.py");
    expect(args).toContain("incoai/Qwen3.8-27B-Splash");
    expect(args).toContain("--served-model-name=qwen3.8-27b-splash");
    expect(args).toContain("222822");
    expect(args).toContain("3321");
    expect(options.env?.HF_HUB_OFFLINE).toBe("1");
    expect(options.env?.HF_HUB_CACHE).toBe("/Users/operator/.cache/huggingface/hub");
    expect(options.env?.OPENAI_API_KEY).toBeUndefined();
    expect(args.join(" ")).not.toContain("download");
    await runtime.shutdown();
  });

  it("blocks low disk before spawn and refuses a user stop during work", async () => {
    const low = harness({ freeBytes: 2 * GIB });
    await expect(low.runtime.start()).rejects.toMatchObject({ code: "splash_disk_low" });
    expect(low.spawnProcess).not.toHaveBeenCalled();
    const busy = harness({ busy: true });
    await busy.runtime.start();
    await expect(busy.runtime.stop()).rejects.toMatchObject({ code: "splash_run_active" });
    expect(busy.terminateGroup).not.toHaveBeenCalled();
    await busy.runtime.shutdown();
    expect(busy.terminateGroup).toHaveBeenCalledOnce();
  });

  it("checks the selected weight-cache volume when Splash cache relocation is configured", async () => {
    const previous = process.env.SPLASH_WEIGHT_CACHE;
    process.env.SPLASH_WEIGHT_CACHE = "/Volumes/External/Splash";
    try {
      const relocated = harness({ freeByPath: { "/paperclip-v2": 2 * GIB, "/Volumes/External/Splash": 10 * GIB } });
      await expect(relocated.runtime.start()).resolves.toMatchObject({ state: "ready" });
      expect(relocated.spawnProcess.mock.calls[0]?.[2].env?.SPLASH_WEIGHT_CACHE).toBe("/Volumes/External/Splash");
      await relocated.runtime.shutdown();
    } finally {
      if (previous === undefined) delete process.env.SPLASH_WEIGHT_CACHE;
      else process.env.SPLASH_WEIGHT_CACHE = previous;
    }
  });

  it("does not load another large LLM beside an existing local model", async () => {
    const existing = harness({ otherModelLoaded: true });
    await expect(existing.runtime.start()).rejects.toMatchObject({ code: "splash_other_model_loaded" });
    expect(existing.spawnProcess).not.toHaveBeenCalled();
  });

  it("rejects an occupied Splash port before spawning", async () => {
    const occupied = harness({ portAvailable: false });
    await expect(occupied.runtime.start()).rejects.toMatchObject({ code: "splash_port_busy" });
    expect(occupied.spawnProcess).not.toHaveBeenCalled();
  });

  it("links the cached model and seeds the catalog without copying weights", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "paperclip-splash-assets-"));
    const root = path.join(temp, "runtime");
    const home = path.join(temp, "home");
    const hub = path.join(temp, "hub");
    const repo = path.join(hub, "models--incoai--Qwen3.8-27B-Splash");
    const revision = "a".repeat(40);
    const snapshot = path.join(repo, "snapshots", revision);
    await mkdir(path.join(root, "install/completions"), { recursive: true });
    await mkdir(path.join(repo, "refs"), { recursive: true });
    await mkdir(snapshot, { recursive: true });
    await writeFile(path.join(repo, "refs/main"), revision);
    await writeFile(path.join(snapshot, "manifest.json"), "{}");
    await writeFile(path.join(root, "install/completions/official-models.txt"), "incoai/Qwen3.8-27B-Splash\n");
    await prepareOfflineSplashAssets(root, home, hub);
    expect(await readlink(path.join(home, "Library/Application Support/Splash/models/incoai/Qwen3.8-27B-Splash"))).toBe(snapshot);
    await prepareOfflineSplashAssets(root, home, hub);
  });

  it("rejects an impostor endpoint and reaps the child after failed startup", async () => {
    const fake = harness({ probe: async () => false });
    await expect(fake.runtime.start()).rejects.toMatchObject({ code: "splash_start_failed" });
    expect(fake.terminateGroup).toHaveBeenCalledOnce();
  });

  it("reports an unexpected child exit and allows another explicit Start", async () => {
    const { runtime, child, spawnProcess } = harness();
    await runtime.start();
    child.exitCode = 1;
    child.emit("exit", 1, null);
    await expect(runtime.status()).resolves.toMatchObject({ state: "stopped", pid: null, lastError: "Bundled Splash exited (1)." });
    child.exitCode = null; // The harness reuses its stand-in child for the next spawn.
    await runtime.start();
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });
});
