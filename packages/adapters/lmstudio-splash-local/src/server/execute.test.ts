import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("undici", () => ({
  Agent: class {},
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));
import { actionlessTurnExhausted, execute } from "./execute.js";
import { assertLmStudioSplashConfig } from "./profile.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
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
function streamTurn(turn: { choices: Array<{ finish_reason: string; message: {
  content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
} }>; usage?: { prompt_tokens: number; completion_tokens: number } }, reasoning?: string): Response {
  const choice = turn.choices[0]!;
  const events: unknown[] = [{ choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] }];
  if (reasoning) events.push({ choices: [{ delta: { reasoning_content: reasoning }, finish_reason: null }] });
  if (choice.message.content) events.push({ choices: [{ delta: { content: choice.message.content }, finish_reason: null }] });
  choice.message.tool_calls?.forEach((call, index) => events.push({ choices: [{ delta: { tool_calls: [{ index,
    id: call.id, type: call.type, function: { name: call.function.name, arguments: call.function.arguments },
  }] }, finish_reason: null }] }));
  events.push({ choices: [{ delta: {}, finish_reason: choice.finish_reason }] });
  if (turn.usage) events.push({ choices: [], usage: turn.usage });
  events.push("[DONE]");
  return new Response(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""),
    { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function context(root: string) {
  return {
    taskId: "task-1",
    wakeReason: "issue_assigned",
    paperclipWorkspace: { cwd: root, source: "execution_workspace" },
    paperclipWake: { reason: "issue_assigned", issue: { id: "task-1", title: "Implement delegated task", status: "todo" } },
  };
}

describe("direct LM Studio Splash heartbeat", () => {
  it.each(["done", "blocked"] as const)("does not consume the model slot for a %s task that changed while queued", async (status) => {
    const root = await workspace();
    const issueId = "8eab2670-f2b8-4d0c-8f95-d595a1c30f78";
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith(`/api/issues/${issueId}`)) return new Response(JSON.stringify({ id: issueId, status }));
      throw new Error(`Unexpected model or control-plane request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const logs: string[] = [];
    const result = await execute({
      runId: "run-stale", agent: { id: "agent-1", companyId: "company-1", name: "Local",
        adapterType: "lmstudio_splash_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: root }, context: { ...context(root), taskId: issueId },
      authToken: "private-run-token", onLog: async (_stream, value) => { logs.push(value); },
    });
    expect(result).toMatchObject({ exitCode: 0, resultJson: { skippedStaleTask: status } });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(logs.join("")).toContain("skipped_stale_task");
    expect(logs.join("")).not.toContain("private-run-token");
  });

  it("skips an unresolved blocker even when the issue status was projected in progress", async () => {
    const root = await workspace();
    const issueId = "8eab2670-f2b8-4d0c-8f95-d595a1c30f78";
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith(`/api/issues/${issueId}`)) return new Response(JSON.stringify({ id: issueId,
        status: "in_progress", blockedBy: [{ id: "blocker-1", status: "in_progress" }] }));
      throw new Error(`Unexpected model or control-plane request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await execute({
      runId: "run-blocked", agent: { id: "agent-1", companyId: "company-1", name: "Local",
        adapterType: "lmstudio_splash_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: root }, context: { ...context(root), taskId: issueId },
      authToken: "private-run-token", onLog: async () => {},
    });
    expect(result).toMatchObject({ resultJson: { skippedStaleTask: "blocked" }, usage: { outputTokens: 0 } });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not apply a completed write tool after the board closes the task mid-generation", async () => {
    const root = await workspace();
    const issueId = "8eab2670-f2b8-4d0c-8f95-d595a1c30f78";
    let sourceReads = 0;
    let completions = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith(`/api/issues/${issueId}`)) {
        sourceReads += 1;
        return new Response(JSON.stringify({ id: issueId, status: sourceReads < 3 ? "in_progress" : "done" }));
      }
      if (url.endsWith(`/api/issues/${issueId}/watchdog`)) return new Response(JSON.stringify({ id: "named-watcher" }));
      const readiness = splashReadiness(url);
      if (readiness) return readiness;
      completions += 1;
      return streamTurn(completions === 1 ? { choices: [{ finish_reason: "tool_calls", message: {
        content: null, tool_calls: [{ id: "call-write", type: "function", function: { name: "write_file",
          arguments: JSON.stringify({ path: "README.md", content: "OVERWRITTEN\n" }) } }],
      } }], usage: { prompt_tokens: 100, completion_tokens: 20 } } : finalTurn);
    }));
    const logs: string[] = [];
    const result = await execute({
      runId: "run-closed", agent: { id: "agent-1", companyId: "company-1", name: "Local",
        adapterType: "lmstudio_splash_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: root }, context: { ...context(root), taskId: issueId },
      authToken: "private-run-token", onLog: async (_stream, value) => { logs.push(value); },
    });
    expect(result).toMatchObject({ resultJson: { skippedStaleTask: "done" } });
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("Project brief\n");
    expect(logs.join("")).not.toContain('"name":"write_file"');
  });

  it("fails closed before inference when the run can no longer confirm its task state", async () => {
    const root = await workspace();
    const issueId = "8eab2670-f2b8-4d0c-8f95-d595a1c30f78";
    let sourceReads = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith(`/api/issues/${issueId}`)) {
        sourceReads += 1;
        if (sourceReads === 1) return new Response(JSON.stringify({ id: issueId, status: "in_progress" }));
        throw new Error("control plane disconnected");
      }
      if (url.endsWith(`/api/issues/${issueId}/watchdog`)) return new Response(JSON.stringify({ id: "named-watcher" }));
      throw new Error(`Unexpected model request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(execute({
      runId: "run-unconfirmed", agent: { id: "agent-1", companyId: "company-1", name: "Local",
        adapterType: "lmstudio_splash_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: root }, context: { ...context(root), taskId: issueId },
      authToken: "private-run-token", onLog: async () => {},
    })).rejects.toThrow("task state could not be confirmed");
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/v1/chat/completions"))).toBe(false);
  });

  it("does not execute a later tool after an earlier tool closes the task in the same batch", async () => {
    const root = await workspace();
    const issueId = "8eab2670-f2b8-4d0c-8f95-d595a1c30f78";
    let sourceStatus = "in_progress";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith(`/api/issues/${issueId}`) && init?.method === "PATCH") {
        sourceStatus = "done";
        return new Response("{}");
      }
      if (url.endsWith(`/api/issues/${issueId}`)) return new Response(JSON.stringify({ id: issueId, status: sourceStatus }));
      if (url.endsWith(`/api/issues/${issueId}/watchdog`)) return new Response(JSON.stringify({ id: "named-watcher" }));
      const readiness = splashReadiness(url);
      if (readiness) return readiness;
      return streamTurn({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [
        { id: "call-close", type: "function", function: { name: "paperclip_request",
          arguments: JSON.stringify({ method: "PATCH", path: `/api/issues/${issueId}`, body: { status: "done" } }) } },
        { id: "call-write", type: "function", function: { name: "write_file",
          arguments: JSON.stringify({ path: "README.md", content: "OVERWRITTEN\n" }) } },
      ] } }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
    }));
    const result = await execute({
      runId: "run-batch", agent: { id: "agent-1", companyId: "company-1", name: "Local",
        adapterType: "lmstudio_splash_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: root }, context: { ...context(root), taskId: issueId },
      authToken: "private-run-token", onLog: async () => {},
    });
    expect(sourceStatus).toBe("done");
    expect(result).toMatchObject({ resultJson: { skippedStaleTask: "done" } });
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("Project brief\n");
  });

  it("allows slow local generation until both the time and output thresholds are reached", () => {
    expect(actionlessTurnExhausted(9 * 60_000, 2_000, 0)).toBe(false);
    expect(actionlessTurnExhausted(7 * 60_000, 25_000, 0)).toBe(false);
    expect(actionlessTurnExhausted(8 * 60_000, 0, 80_000)).toBe(true);
    expect(actionlessTurnExhausted(9 * 60_000, 25_000, 0, 30_000)).toBe(false);
    expect(actionlessTurnExhausted(9 * 60_000, 25_000, 0, 60_000)).toBe(true);
  });

  it("stops a costly actionless model turn before the hard deadline without invoking another provider", async () => {
    const root = await workspace();
    vi.useFakeTimers();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    let statusReads = 0;
    let completions = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/status")) {
        statusReads += 1;
        const ready = splashReadiness(url)!;
        return new Response(JSON.stringify({ ...await ready.json() as object,
          metrics: { decode_output_tokens: statusReads <= 2 ? 0 : 20_500 } }));
      }
      const readiness = splashReadiness(url);
      if (readiness) return readiness;
      completions += 1;
      resolveStarted();
      // The HTTP response has arrived but its SSE body never closes. Aborting
      // only the fetch request is insufficient once reader.read() is pending.
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"thinking"},"finish_reason":null}]}\n\n'));
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }));
    const logs: string[] = [];
    const run = execute({
      runId: "run-actionless", agent: { id: "agent-1", companyId: "company-1", name: "Local",
        adapterType: "lmstudio_splash_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: root }, context: context(root), authToken: "private-run-token",
      onLog: async (_stream, value) => { logs.push(value); },
    });
    const failure = expect(run).rejects.toThrow("no task-tool progress");
    await started;
    await vi.advanceTimersByTimeAsync(8 * 60_000 + 15_000);
    await failure;
    expect(completions).toBe(1);
    expect(logs.join("")).toContain("scope_stall");
    expect(logs.join("")).not.toContain("private-run-token");
  });

  it("installs a local self-watchdog for a task and preserves a named existing watcher", async () => {
    const root = await workspace();
    const issueId = "8eab2670-f2b8-4d0c-8f95-d595a1c30f78";
    const agentId = "cc349b6e-bb92-45c3-b16c-e5f69c971015";
    const requests: Array<{ url: string; method: string; body: string | null }> = [];
    let existingWatchdog: unknown = null;
    let sourceOriginKind: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: init?.body ? String(init.body) : null });
      if (url.endsWith(`/api/issues/${issueId}`)) return new Response(JSON.stringify({ id: issueId, originKind: sourceOriginKind }));
      if (url.endsWith(`/api/issues/${issueId}/watchdog`)) {
        return new Response(JSON.stringify(method === "PUT" ? { id: "watchdog-new" } : existingWatchdog));
      }
      const readiness = splashReadiness(url);
      if (readiness) return readiness;
      return streamTurn(finalTurn);
    }));
    const run = () => execute({
      runId: "run-self-watch", agent: { id: agentId, companyId: "company-1", name: "Local", role: "engineer",
        adapterType: "lmstudio_splash_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: root }, context: { ...context(root), taskId: issueId },
      authToken: "private-run-token", onLog: async () => {},
    });
    await run();
    const writes = requests.filter((request) => request.method === "PUT");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.body!)).toMatchObject({ agentId });
    expect(writes[0]!.url).toContain(`/api/issues/${issueId}/watchdog`);
    expect(JSON.stringify(requests)).not.toContain("private-run-token");
    existingWatchdog = { id: "named-watchdog", watchdogAgentId: "another-local-agent" };
    requests.length = 0;
    await run();
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(0);
    sourceOriginKind = "task_watchdog";
    existingWatchdog = null;
    requests.length = 0;
    await run();
    expect(requests.filter((request) => request.url.endsWith(`/api/issues/${issueId}/watchdog`))).toHaveLength(0);
  });

  it("routes broad CTO work toward named, bounded child assignments", async () => {
    const root = await workspace();
    const requests: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const readiness = splashReadiness(url);
      if (readiness) return readiness;
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return streamTurn(finalTurn, "PRIVATE_LOCAL_REASONING");
    }));
    await execute({
      runId: "run-cto", agent: { id: "agent-cto", companyId: "company-1", name: "CTO", role: "cto",
        adapterType: "lmstudio_splash_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: root }, context: context(root), authToken: "run-token", onLog: async (_stream, value) => { logs.push(value); },
    });
    const system = (requests[0]?.messages as Array<{ content: string }>)[0]?.content ?? "";
    expect(system).toContain("at most three narrow child issues");
    expect(system).toContain("If the current issue asks for implementation, implement its scoped deliverable yourself");
    expect(system).toContain("explicit assignees");
    expect(system).toContain("idempotency key");
    expect(system).toContain("named account binding");
    expect(system).toContain("project workspace");
    expect(system).toContain("task watchdog");
    expect(system).toContain("Keep the parent blocked on unfinished children");
    expect(logs.join("")).not.toContain("PRIVATE_LOCAL_REASONING");
  });

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
      return streamTurn(finalTurn);
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
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const second = run("run-second");
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(modelProbes).toBe(1);
      expect(completions).toBe(1);
      expect(dispatches).toEqual(["run-first"]);
      expect(cancellationReady).toEqual(["run-first", "run-second"]);
      expect(progress).toContain("Queued for the local Splash model (joined at position 1).");
      expect(progress).toContain("Waiting for the local Splash model; another local run has the slot.");
    } finally { releaseFirst(); vi.useRealTimers(); }
    await Promise.all([first, second]);
    expect(modelProbes).toBe(2);
    expect(completions).toBe(2);
    expect(dispatches).toEqual(["run-first", "run-second"]);
    expect(progress.filter((message) => message === "Local Splash model slot acquired.")).toHaveLength(2);
  });

  it("accepts controller-owned scratch and Git environment but rejects paid provider keys", () => {
    expect(assertLmStudioSplashConfig({ env: {
      PAPERCLIP_RUN_SCRATCH_DIR: "/tmp/run", TMPDIR: "/tmp/run", GIT_CONFIG_NOSYSTEM: "1",
    } })).toBe(24);
    expect(() => assertLmStudioSplashConfig({ env: { OPENAI_API_KEY: "paid-key" } })).toThrow("provider environment");
  });
  it("executes a bounded coding tool call and returns a task response without a provider session", async () => {
    const root = await workspace();
    const requests: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const readiness = splashReadiness(url);
      if (readiness) return readiness;
      if (url.endsWith("/v1/chat/completions")) return streamTurn(requests.filter((item) => item.url.endsWith("/v1/chat/completions")).length === 1 ? toolTurn : finalTurn);
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
      return streamTurn(finalTurn);
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
    const fetcher = vi.fn(async (url: string) => splashReadiness(url) ?? streamTurn(toolTurn));
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
    const fetcher = vi.fn(async (url: string) => splashReadiness(url) ?? streamTurn(commandTurn));
    vi.stubGlobal("fetch", fetcher);
    await expect(execute({
      runId: "run-4", agent: { id: "agent-1", companyId: "company-1", name: "Local", adapterType: "lmstudio_splash_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: root }, context: context(root), authToken: "run-token", onLog: async () => {},
    })).rejects.toThrow("timed out");
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/v1/chat/completions"))).toHaveLength(1);
  });
});
