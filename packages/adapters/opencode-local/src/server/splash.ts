export const SPLASH_MODEL = "splash/incoai/Qwen3.8-27B-Splash";
const SPLASH_API_MODEL = "incoai/Qwen3.8-27B-Splash";

/** A dedicated route cannot accept later CLI options that may replace its model or server. */
export function assertLocalSplashCliOverridesAbsent(config: Record<string, unknown>): void {
  if ((Array.isArray(config.extraArgs) && config.extraArgs.length > 0) ||
      (Array.isArray(config.args) && config.args.length > 0)) {
    throw new Error("Local Splash does not accept extra arguments; remove CLI overrides before selecting this route.");
  }
}

/** Probe only loopback metadata. This never starts Splash or runs inference. */
export async function assertLocalSplashReady(model: unknown, fetcher: typeof fetch = fetch): Promise<void> {
  if (model !== SPLASH_MODEL) throw new Error(`Splash requires ${SPLASH_MODEL}.`);
  try {
    const response = await fetcher("http://127.0.0.1:8000/v1/models", {
      signal: AbortSignal.timeout(1500),
      redirect: "error",
    });
    if (!response.ok) throw new Error("models endpoint unavailable");
    const body: unknown = await response.json();
    const entries = body && typeof body === "object" && "data" in body && Array.isArray(body.data)
      ? body.data : [];
    if (!entries.some((entry: unknown) => entry && typeof entry === "object" && "id" in entry && entry.id === SPLASH_API_MODEL)) {
      throw new Error("selected model is not loaded");
    }
  } catch {
    throw new Error("Local Splash is not ready with incoai/Qwen3.8-27B-Splash at 127.0.0.1:8000. Start and verify Splash explicitly before using this agent.");
  }
}
