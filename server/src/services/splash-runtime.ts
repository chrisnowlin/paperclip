import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { access, copyFile, lstat, mkdir, readFile, realpath, statfs, symlink, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { splashRunQueue } from "@paperclipai/adapter-lmstudio-splash-local/server";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

export const APP_SPLASH_PORT = 3321;
export const APP_SPLASH_MODEL = "incoai/Qwen3.8-27B-Splash";
export const APP_SPLASH_ALIAS = "qwen3.8-27b-splash";
const BASE = `http://127.0.0.1:${APP_SPLASH_PORT}`;
const MIN_FREE_BYTES = 8 * 1024 ** 3;
const MIN_INSTANCE_FREE_BYTES = 512 * 1024 ** 2;

export class SplashRuntimeError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export interface SplashRuntimeStatus {
  state: "stopped" | "starting" | "ready";
  model: typeof APP_SPLASH_MODEL;
  port: typeof APP_SPLASH_PORT;
  pid: number | null;
  lastError: string | null;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65_536) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { return null; }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Verifies the fixed listener belongs to the child we started, not a port squatter. */
export async function probeAppOwnedSplash(pid: number, fetcher: typeof fetch = fetch): Promise<boolean> {
  const get = async (suffix: string) => boundedJson(await fetcher(`${BASE}${suffix}`, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(2_000),
  }));
  try {
    const ready = record(await get("/ready"));
    if (ready.status !== "ready") return false;
    const instance = record(record(await get("/status")).instance);
    if (instance.pid !== pid || instance.model !== APP_SPLASH_MODEL ||
        instance.host !== "127.0.0.1" || instance.port !== APP_SPLASH_PORT) return false;
    const models = record(await get("/v1/models")).data;
    return Array.isArray(models) && models.some((entry: unknown) => {
      const model = record(entry);
      return model.id === APP_SPLASH_ALIAS && model.root === APP_SPLASH_MODEL && model.owned_by === "splash";
    });
  } catch { return false; }
}

async function otherLocalModelLoaded(fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher("http://127.0.0.1:1234/api/v1/models", {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(1_000),
    });
    const models = record(await boundedJson(response)).models;
    if (Array.isArray(models) && models.some((entry: unknown) => {
      const model = record(entry);
      return model.type === "llm" && Array.isArray(model.loaded_instances) && model.loaded_instances.length > 0;
    })) return true;
  } catch { /* Bionic is closed */ }
  try {
    const response = await fetcher("http://127.0.0.1:8000/status", {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(1_000),
    });
    return typeof record(record(await boundedJson(response)).instance).model === "string";
  } catch { return false; }
}

async function splashPortAvailable(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(APP_SPLASH_PORT, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** Creates only small, app-owned metadata; the weight files stay in the Hub cache. */
export async function prepareOfflineSplashAssets(root: string, splashHome: string, hubCache: string): Promise<void> {
  const repository = path.join(hubCache, "models--incoai--Qwen3.8-27B-Splash");
  const revision = (await readFile(path.join(repository, "refs/main"), "utf8")).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Cached Splash model revision is invalid.");
  const snapshot = path.join(repository, "snapshots", revision);
  await access(path.join(snapshot, "manifest.json"));
  const data = path.join(splashHome, "Library/Application Support/Splash");
  const modelParent = path.join(data, "models/incoai");
  await mkdir(modelParent, { recursive: true, mode: 0o700 });
  const modelLink = path.join(modelParent, "Qwen3.8-27B-Splash");
  const existing = await lstat(modelLink).then(() => true, () => false);
  if (existing) {
    if (await realpath(modelLink) !== await realpath(snapshot)) throw new Error("App-owned Splash model link points at another snapshot.");
  } else {
    await symlink(snapshot, modelLink);
  }
  const catalogDir = path.join(data, "catalog");
  await mkdir(catalogDir, { recursive: true, mode: 0o700 });
  const catalog = path.join(catalogDir, "official-models.txt");
  await copyFile(path.join(root, "install/completions/official-models.txt"), catalog);
  const now = new Date();
  await utimes(catalog, now, now);
}

type SplashChild = Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "stdout" | "stderr" | "once">;
type SpawnSplash = (command: string, args: string[], options: SpawnOptions) => SplashChild;

interface SplashRuntimeDependencies {
  runtimeRoot: string | null;
  instanceRoot: string;
  hubCache: string;
  fileExists?: (file: string) => Promise<boolean>;
  ensureDir?: (dir: string) => Promise<void>;
  freeBytes?: (target: string) => Promise<number>;
  spawnProcess?: SpawnSplash;
  terminateGroup?: (child: SplashChild) => Promise<void>;
  probe?: (pid: number) => Promise<boolean>;
  otherModelLoaded?: () => Promise<boolean>;
  portAvailable?: () => Promise<boolean>;
  prepareAssets?: (root: string, splashHome: string, hubCache: string) => Promise<void>;
  wait?: (ms: number) => Promise<void>;
  hasActiveRun?: () => boolean;
}

async function terminateChildGroup(child: SplashChild): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-pid, "SIGTERM"); } catch { return; }
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  try { process.kill(-pid, "SIGKILL"); } catch { /* group has exited */ }
}

export class AppOwnedSplashRuntime {
  private child: SplashChild | null = null;
  private starting: Promise<SplashRuntimeStatus> | null = null;
  private stopping = false;
  private lastError: string | null = null;
  private readonly deps: Required<SplashRuntimeDependencies>;

  constructor(dependencies: SplashRuntimeDependencies) {
    const runtimeRoot = dependencies.runtimeRoot;
    const instanceRoot = dependencies.instanceRoot;
    const hubCache = dependencies.hubCache;
    this.deps = {
      ...dependencies,
      runtimeRoot: runtimeRoot ?? "",
      fileExists: dependencies.fileExists ?? (async (file) => access(file).then(() => true, () => false)),
      ensureDir: dependencies.ensureDir ?? (async (dir) => { await mkdir(dir, { recursive: true, mode: 0o700 }); }),
      freeBytes: dependencies.freeBytes ?? (async (target) => {
        const info = await statfs(target);
        return info.bavail * info.bsize;
      }),
      spawnProcess: dependencies.spawnProcess ?? ((command, args, options) => spawn(command, args, options)),
      terminateGroup: dependencies.terminateGroup ?? terminateChildGroup,
      probe: dependencies.probe ?? probeAppOwnedSplash,
      otherModelLoaded: dependencies.otherModelLoaded ?? (() => otherLocalModelLoaded()),
      portAvailable: dependencies.portAvailable ?? splashPortAvailable,
      prepareAssets: dependencies.prepareAssets ?? prepareOfflineSplashAssets,
      wait: dependencies.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      hasActiveRun: dependencies.hasActiveRun ?? (() => splashRunQueue.hasActiveWork()),
      instanceRoot, hubCache,
    };
  }

  async status(): Promise<SplashRuntimeStatus> {
    const child = this.child;
    const pid = child?.pid ?? null;
    const alive = Boolean(child && pid && child.exitCode === null && child.signalCode === null);
    const state = alive ? await this.deps.probe(pid!) ? "ready" : "starting" : "stopped";
    return { state, model: APP_SPLASH_MODEL, port: APP_SPLASH_PORT, pid: alive ? pid : null, lastError: this.lastError };
  }

  async requireReady(): Promise<void> {
    if ((await this.status()).state !== "ready") {
      throw new SplashRuntimeError("splash_not_started", "Start the bundled Splash model in Paperclip before assigning work.");
    }
  }

  start(): Promise<SplashRuntimeStatus> {
    if (this.starting) return this.starting;
    this.starting = this.startInner().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startInner(): Promise<SplashRuntimeStatus> {
    if (this.child) {
      const current = await this.status();
      if (current.state === "ready") return current;
      throw new SplashRuntimeError("splash_starting", "The bundled Splash process is already starting.");
    }
    const root = this.deps.runtimeRoot;
    if (!root) {
      throw new SplashRuntimeError("splash_bundle_missing", "V2 does not contain its bundled Splash runtime. Rebuild the app bundle.");
    }
    const python = path.join(root, "python/bin/python3");
    const launcher = path.join(root, "install/launcher.py");
    const engine = path.join(root, "engine/splash");
    const manifest = path.join(root, "release.json");
    if (!await Promise.all([python, launcher, engine, manifest].map(this.deps.fileExists)).then((values) => values.every(Boolean))) {
      throw new SplashRuntimeError("splash_bundle_missing", "V2 does not contain its bundled Splash runtime. Rebuild the app bundle.");
    }
    if (!await this.deps.fileExists(path.join(this.deps.hubCache, "models--incoai--Qwen3.8-27B-Splash"))) {
      throw new SplashRuntimeError("splash_model_missing", "The local Qwen Splash weights are not cached. Paperclip will not download them.");
    }
    const splashHome = path.join(this.deps.instanceRoot, "splash-home");
    const splashTmp = path.join(this.deps.instanceRoot, "splash-tmp");
    await Promise.all([this.deps.ensureDir(this.deps.instanceRoot), this.deps.ensureDir(splashHome), this.deps.ensureDir(splashTmp)]);
    const configuredWeightCache = process.env.SPLASH_WEIGHT_CACHE?.trim();
    if (configuredWeightCache && !path.isAbsolute(configuredWeightCache)) {
      throw new SplashRuntimeError("splash_cache_invalid", "SPLASH_WEIGHT_CACHE must be an absolute directory path.");
    }
    const instanceFree = await this.deps.freeBytes(this.deps.instanceRoot);
    if (instanceFree < MIN_INSTANCE_FREE_BYTES) {
      throw new SplashRuntimeError("splash_disk_low", `At least 0.5 GiB free disk is required for V2 runtime metadata; ${(instanceFree / 1024 ** 3).toFixed(1)} GiB is available.`);
    }
    const weightCacheTarget = configuredWeightCache || this.deps.instanceRoot;
    const free = await this.deps.freeBytes(weightCacheTarget).catch(() => {
      throw new SplashRuntimeError("splash_cache_unavailable", "The configured SPLASH_WEIGHT_CACHE directory is unavailable.");
    });
    if (free < MIN_FREE_BYTES) {
      throw new SplashRuntimeError("splash_disk_low", `At least 8 GiB free disk is required on the Splash weight-cache volume; ${(free / 1024 ** 3).toFixed(1)} GiB is available.`);
    }
    if (await this.deps.otherModelLoaded()) {
      throw new SplashRuntimeError("splash_other_model_loaded", "Unload the other local LLM before starting bundled Splash on this Mac.");
    }
    if (!await this.deps.portAvailable()) {
      throw new SplashRuntimeError("splash_port_busy", "Port 3321 is in use. Stop the other listener before starting bundled Splash.");
    }
    try { await this.deps.prepareAssets(root, splashHome, this.deps.hubCache); }
    catch {
      throw new SplashRuntimeError("splash_model_missing", "The existing Qwen Splash snapshot cannot be prepared offline; no weights were downloaded.");
    }
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin", HOME: splashHome, TMPDIR: splashTmp,
      LANG: process.env.LANG ?? "en_US.UTF-8", HF_HUB_CACHE: this.deps.hubCache,
      HF_HUB_OFFLINE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1",
    };
    if (configuredWeightCache) env.SPLASH_WEIGHT_CACHE = configuredWeightCache;
    const args = ["-u", launcher, "serve", "--host", "127.0.0.1", "--port", String(APP_SPLASH_PORT),
      "--model", APP_SPLASH_MODEL, `--served-model-name=${APP_SPLASH_ALIAS}`,
      "--max-memory", "28G", "--max-context", "32K", "--no-webui"];
    let child: SplashChild;
    try {
      child = this.deps.spawnProcess(python, args, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      throw new SplashRuntimeError("splash_start_failed", "Could not launch the bundled Splash runtime.");
    }
    if (!child.pid) throw new SplashRuntimeError("splash_start_failed", "The bundled Splash runtime did not start.");
    this.child = child;
    this.lastError = null;
    child.stdout?.resume();
    child.stderr?.resume();
    child.once("exit", (code) => {
      if (this.child === child) this.child = null;
      if (!this.stopping) this.lastError = `Bundled Splash exited (${code ?? "signal"}).`;
    });
    child.once("error", () => {
      if (this.child === child) this.child = null;
      this.lastError = "Bundled Splash failed to launch.";
    });
    try {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (this.child !== child || child.exitCode !== null || child.signalCode !== null) break;
        if (await this.deps.probe(child.pid)) return await this.status();
        await this.deps.wait(1_000);
      }
      throw new SplashRuntimeError("splash_start_failed", "Bundled Splash did not become ready with the exact Qwen model.");
    } catch (error) {
      await this.deps.terminateGroup(child);
      if (this.child === child) this.child = null;
      this.lastError = error instanceof Error ? error.message : "Bundled Splash startup failed.";
      if (error instanceof SplashRuntimeError) throw error;
      throw new SplashRuntimeError("splash_start_failed", "Bundled Splash startup failed.");
    }
  }

  async stop(): Promise<SplashRuntimeStatus> {
    if (this.starting) {
      throw new SplashRuntimeError("splash_starting", "Splash is still starting. Stop it after startup finishes.");
    }
    if (this.deps.hasActiveRun()) {
      throw new SplashRuntimeError("splash_run_active", "Stop the active Splash task before stopping its model server.");
    }
    await this.shutdown();
    return await this.status();
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    try { await this.deps.terminateGroup(child); }
    finally { if (this.child === child) this.child = null; this.stopping = false; }
  }

  terminateOnProcessExit(): void {
    const pid = this.child?.pid;
    if (!pid) return;
    try { process.kill(-pid, "SIGTERM"); } catch { /* child has exited */ }
  }
}

export const appOwnedSplashRuntime = new AppOwnedSplashRuntime({
  runtimeRoot: process.env.PAPERCLIP_SPLASH_RUNTIME_ROOT ?? null,
  instanceRoot: resolvePaperclipInstanceRoot(),
  hubCache: process.env.PAPERCLIP_SPLASH_HF_HUB_CACHE?.trim() || path.join(os.homedir(), ".cache/huggingface/hub"),
});
