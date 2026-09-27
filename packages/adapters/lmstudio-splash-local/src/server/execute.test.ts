import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("undici", () => ({
  Agent: class {},
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));
import { execute } from "./execute.js";
import { assertLmStudioSplashConfig } from "./profile.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-lmstudio-run-"));
  roots.push(root);
  await writeFile(path.join(root, "README.md"), "Project brief\n");
  return root;
}
function splashReadiness(url: string): Response | null {
  if (url.endsWith("/ready")) return new Response(JSON.stringify({ status: "ready" }));
  if (url.endsWith("/apply-template")) return new Response(JSON.stringify({ prompt: "rendered prompt" }));
  if (url.endsWith("/tokenize")) return new Response(JSON.stringify({ tokens: Array(100).fill(1) }));
  if (url.endsWith("/status")) return new Response(JSON.stringify({ maximum_context_tokens: 222_822, instance: {
    model: "incoai/Qwen3.8-27B-Splash", host: "127.0.0.1", port: 3321,
  } }));
  if (url.endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{
    id: "qwen3.8-27b-splash", root: "incoai/Qwen3.8-27B-Splash", owned_by: "splash",
  }] }));
  return null;
}
const toolTurn = { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{
  id: "call-read", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' },
}] } }], usage: { prompt_tokens: 10, completion_tokens: 3 } };
const finalTurn = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Delegated task acknowledged." } }],
  usage: { prompt_tokens: 14, completion_tokens: 5 } };

function context(root: string) {
  return {
    taskId: "task-1",
    wakeReason: "issue_assigned",
    paperclipWorkspace: { cwd: root, source: "execution_workspace" },
    paperclipWake: { reason: "issue_assigned", issue: { id: "task-1", title: "Implement delegated task", status: "todo" } },
  };
}

describe("direct LM Studio Splash heartbeat", () => {
  it("serializes two agents through one model slot and reports the wait", async () => {
    const root = await workspace();
    let releaseFirst!: () => void;
    let startedFirst!: () => void;
    const firstTurnHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstTurnStarted = new Promise<void>((resolve) => { startedFirst = resolve; });
    let modelProbes = 0;
    let completions = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const readiness = splashReadiness(url);
      if (readiness) { if (url.endsWith("/v1/models")) modelProbes += 1; return readiness; }
      completions += 1;
      if (completions === 1) { startedFirst(); await firstTurnHeld; }
      return new Response(JSON.stringify(finalTurn));
    }));
    const progress: string[] = [];
    const dispatches: string[] = [];
    const cancellationReady: string[] = [];
    const run = (runId: string) => execute({
      runId, agent: { id: runId, companyId: "company-1", name: "Local", adapterType: "lmstudio_splash_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: root }, context: context(root), authToken: "run-token",
      onLog: async () => {}, onRuntimeProgress: async (update) => { progress.push(update.message); },
      onCancellationReady: async () => { cancellationReady.push(runId); },
      onDispatch: () => { dispatches.push(runId); },
    });
    const first = run("run-first");
    await firstTurnStarted;
    const second = run("run-second");
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(modelProbes).toBe(1);
      expect(completions).toBe(1);
      expect(dispatches).toEqual(["run-first"]);
      expect(cancellationReady).toEqual(["run-first", "run-second"]);
      expect(progress).toContain("Queued for the local Splash model (joined at position 1).");
    } finally { releaseFirst(); }
    await Promise.all([first, second]);
    expect(modelProbes).toBe(2);
    expect(completions).toBe(2);
    expect(dispatches).toEqual(["run-first", "run-second"]);
    expect(progress.filter((message) => message === "Local Splash model slot acquired.")).toHaveLength(2);
  });

  it("accepts controller-owned scratch and Git environment but rejects paid provider keys", () => {
    expect(assertLmStudioSplashConfig({ env: {
      PAPERCLIP_RUN_SCRATCH_DIR: "/tmp/run", TMPDIR: "/tmp/run", GIT_CONFIG_NOSYSTEM: "1",
    } })).toBe(20);
    expect(() => assertLmStudioSplashConfig({ env: { OPENAI_API_KEY: "paid-key" } })).toThrow("provider environment");
  });
  it("executes a bounded coding tool call and returns a task response without a provider session", async () => {
    const root = await workspace();
    const requests: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const readiness = splashReadiness(url);
      if (readiness) return readiness;
      if (url.endsWith("/v1/chat/completions")) return new Response(JSON.stringify(requests.filter((item) => item.url.endsWith("/v1/chat/completions")).length === 1 ? toolTurn : finalTurn), { status: 200 });
      throw new Error("Unexpected URL");
    }));
    const logs: string[] = [];
    const result = await execute({
      runId: "run-1", agent: { id: "agent-1", companyId: "company-1", name: "Local", adapterType: "lmstudio_splash_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: root }, context: context(root), authToken: "private-run-token",
      onLog: async (_stream, text) => { logs.push(text); },
    });
    expect(result).toMatchObject({ exitCode: 0, model: "qwen3.8-27b-splash", costUsd: 0,
      sessionId: null, clearSession: true, summary: "Delegated task acknowledged.",
      usage: { inputTokens: 24, outputTokens: 8 } });
    expect(requests.filter((item) => item.url.endsWith("/v1/models"))).toHaveLength(2);
    const turns = requests.filter((item) => item.url.endsWith("/v1/chat/completions"));
    expect(turns).toHaveLength(2);
    expect(JSON.stringify(turns[0]?.body)).toContain("Implement delegated task");
    expect(JSON.stringify(turns[1]?.body)).toContain("Project brief");
    expect(JSON.stringify(turns)).not.toContain("private-run-token");
    expect(JSON.stringify(logs)).not.toContain("private-run-token");
  });

  it("does not start inference for an unloaded model or an existing paid binding", async () => {
    const root = await workspace();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: "unavailable" }), { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const base = {
      runId: "run-2", agent: { id: "agent-1", companyId: "company-1", name: "Local", adapterType: "lmstudio_splash_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      context: context(root), authToken: "run-token", onLog: async () => {},
    };
    await expect(execute({ ...base, config: { cwd: root } })).rejects.toThrow("readiness failed");
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(execute({ ...base, config: { cwd: root, managedAiConnection: true } })).rejects.toThrow("AI Connection");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("responds to a delegated task's later comment without claiming a persisted provider session", async () => {
    const root = await workspace();
    const requests: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const readiness = splashReadiness(url);
      if (readiness) return readiness;
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(finalTurn), { status: 200 });
    }));
    const result = await execute({
      runId: "run-comment", agent: { id: "agent-1", companyId: "company-1", name: "Local", adapterType: "lmstudio_splash_local", adapterConfig: {} },
      runtime: { sessionId: "old-provider-session", sessionParams: { sessionId: "old-provider-session" }, sessionDisplayId: "old-provider-session", taskKey: null },
      config: { cwd: root }, context: {
        taskId: "task-1", paperclipWorkspace: { cwd: root, source: "execution_workspace" },
        paperclipWake: { reason: "issue_commented", issue: { id: "task-1", title: "Implement delegated task", status: "in_progress" },
          comments: [{ id: "comment-1", body: "Please include the acceptance check.", createdAt: "2026-09-26T12:00:00Z" }] },
      }, authToken: "run-token", onLog: async () => {},
    });
    expect(JSON.stringify(requests[0])).toContain("Please include the acceptance check.");
    expect(result).toMatchObject({ sessionId: null, sessionParams: null, clearSession: true });
  });

  it("stops on cancellation and on the configured step limit", async () => {
    const root = await workspace();
    const cancelled = new AbortController();
    cancelled.abort();
    const fetcher = vi.fn(async (url: string) => splashReadiness(url) ?? new Response(JSON.stringify(toolTurn), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const base = {
      runId: "run-3", agent: { id: "agent-1", companyId: "company-1", name: "Local", adapterType: "lmstudio_splash_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      context: context(root), authToken: "run-token", onLog: async () => {},
    };
    await expect(execute({ ...base, config: { cwd: root }, signal: cancelled.signal })).rejects.toThrow("cancelled");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(execute({ ...base, config: { cwd: root, maxSteps: 2 } })).rejects.toThrow("step limit");
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/v1/chat/completions"))).toHaveLength(2);
  });

  it("stops after a timed-out coding command instead of asking the model to repeat it", async () => {
    const root = await workspace();
    const commandTurn = { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{
      id: "call-command", type: "function", function: { name: "run_command", arguments: JSON.stringify({
        command: "node", args: ["-e", "setTimeout(()=>{},1000)"], timeoutMs: 30,
      }) },
    }] } }] };
    const fetcher = vi.fn(async (url: string) => splashReadiness(url) ?? new Response(JSON.stringify(commandTurn), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(execute({
      runId: "run-4", agent: { id: "agent-1", companyId: "company-1", name: "Local", adapterType: "lmstudio_splash_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: root }, context: context(root), authToken: "run-token", onLog: async () => {},
    })).rejects.toThrow("timed out");
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/v1/chat/completions"))).toHaveLength(1);
  });
});
