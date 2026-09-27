import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { buildPaperclipEnv, joinPromptSections, renderPaperclipWakePrompt, selectPaperclipTaskMarkdown } from "@paperclipai/adapter-utils/server-utils";
import { completeLmStudioTurn, LMSTUDIO_SPLASH_MODEL, probeLmStudioSplash, readSplashDecodeTokens, type LmStudioMessage } from "./model.js";
import { assertLmStudioSplashConfig } from "./profile.js";
import { splashRunQueue } from "./run-queue.js";
import { createLmStudioToolExecutor, InterruptedCodingCommandError, UncertainPaperclipMutationError } from "./tools.js";

const MAX_TOOL_CALLS = 48;
const MAX_RUN_MS = 25 * 60 * 1_000;
const MAX_QUEUE_WAIT_MS = 25 * 60 * 1_000;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const maxSteps = assertLmStudioSplashConfig(ctx.config);
  if (ctx.executionTarget?.kind === "remote") throw new Error("App-managed Splash cannot run on a remote execution target.");
  if (!ctx.authToken) throw new Error("App-managed Splash requires a run-scoped Paperclip credential for task tools.");
  const workspace = record(ctx.context.paperclipWorkspace);
  const cwd = typeof workspace.cwd === "string" && workspace.cwd ? workspace.cwd : ctx.config.cwd;
  if (typeof cwd !== "string" || !cwd) throw new Error("App-managed Splash requires a selected local workspace.");
  if (ctx.signal?.aborted) throw new Error("App-managed Splash run was cancelled.");
  await ctx.onCancellationReady?.();
  const queueSignal = ctx.signal
    ? AbortSignal.any([ctx.signal, AbortSignal.timeout(MAX_QUEUE_WAIT_MS)])
    : AbortSignal.timeout(MAX_QUEUE_WAIT_MS);
  const reportQueueStatus = async (message: string) => {
    try { await ctx.onRuntimeProgress?.({ phase: "adapter_startup", message }); }
    catch { /* progress reporting must not prevent local work */ }
  };
  let queuedProgress: Promise<void> | null = null;
  const release = await splashRunQueue.acquire(queueSignal, (position) => {
    queuedProgress = reportQueueStatus(`Queued for the local Splash model (joined at position ${position}).`);
  });
  try {
    if (queuedProgress) await queuedProgress;
    await reportQueueStatus("Local Splash model slot acquired.");
    const runSignal = ctx.signal
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(MAX_RUN_MS)])
      : AbortSignal.timeout(MAX_RUN_MS);
    const apiUrl = buildPaperclipEnv(ctx.agent).PAPERCLIP_API_URL;
    const executor = await createLmStudioToolExecutor({ workspace: cwd, companyId: ctx.agent.companyId,
      runId: ctx.runId, authToken: ctx.authToken, apiUrl, signal: runSignal, onSpawn: ctx.onSpawn });
    const wake = renderPaperclipWakePrompt(ctx.context.paperclipWake);
    const task = selectPaperclipTaskMarkdown(ctx.context);
    const prompt = joinPromptSections([wake, task, typeof ctx.config.promptTemplate === "string" ? ctx.config.promptTemplate : ""]);
    if (!prompt) throw new Error("App-managed Splash received no task context.");
    await ctx.onMeta?.({ adapterType: "lmstudio_splash_local", command: "Bundled Splash local API", cwd,
      commandNotes: ["Fixed model and loopback endpoint; no provider session or paid account."], prompt });
    const messages: LmStudioMessage[] = [
      { role: "system", content: "You are a local Paperclip coding agent. Use the provided tools for workspace and task actions. Never request credentials or alternate model endpoints. Report completed work clearly." },
      { role: "user", content: prompt },
    ];
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCallCount = 0;
    let dispatched = false;
    for (let step = 0; step < maxSteps; step += 1) {
      if (runSignal.aborted) throw new Error("App-managed Splash run was cancelled or timed out.");
      await probeLmStudioSplash(fetch, runSignal);
      if (!dispatched) { ctx.onDispatch?.(); dispatched = true; }
      await reportQueueStatus("Splash is generating locally; a turn can take several minutes.");
      const turnStarted = Date.now();
      const decodeBaseline = await readSplashDecodeTokens(fetch, runSignal);
      let budget: { promptTokens: number; maxOutputTokens: number } | null = null;
      let lastGenerated = 0;
      let turnActive = true;
      let progressPending = false;
      const progressTimer = setInterval(() => {
        if (!turnActive || progressPending) return;
        progressPending = true;
        void (async () => {
          const current = await readSplashDecodeTokens(fetch, runSignal);
          if (!turnActive) return;
          if (current !== null && decodeBaseline !== null) lastGenerated = Math.max(lastGenerated, current - decodeBaseline);
          const elapsed = Math.max(1, Math.floor((Date.now() - turnStarted) / 60_000));
          const count = decodeBaseline === null ? "token count unavailable" : `~${lastGenerated.toLocaleString("en-US")} output tokens`;
          const limit = budget ? `, ${budget.promptTokens.toLocaleString("en-US")} prompt / ${budget.maxOutputTokens.toLocaleString("en-US")} output limit` : "";
          await reportQueueStatus(`Splash generating locally: ${count}${limit} (${elapsed} min elapsed).`);
        })().finally(() => { progressPending = false; });
      }, 15_000);
      progressTimer.unref();
      let turn: Awaited<ReturnType<typeof completeLmStudioTurn>>;
      try { turn = await completeLmStudioTurn({ messages, tools: executor.definitions, signal: runSignal,
        onTokenBudget: async (measured) => {
          budget = measured;
          await reportQueueStatus(`Splash prompt: ${measured.promptTokens.toLocaleString("en-US")} tokens; output allowance: ${measured.maxOutputTokens.toLocaleString("en-US")} tokens.`);
        } }); }
      finally { turnActive = false; clearInterval(progressTimer); }
      inputTokens += turn.usage.inputTokens;
      outputTokens += turn.usage.outputTokens;
      if (turn.toolCalls.length === 0) {
        const summary = turn.content ?? "";
        await ctx.onLog("stdout", `${JSON.stringify({ type: "assistant", text: summary })}\n`);
        return { exitCode: 0, signal: null, timedOut: false, provider: "splash", biller: "local",
          model: LMSTUDIO_SPLASH_MODEL, billingType: "fixed", costUsd: 0, usageBasis: "per_run",
          usage: { inputTokens, outputTokens }, sessionId: null, sessionParams: null,
          sessionDisplayId: null, clearSession: true, summary: summary.slice(0, 12_000),
          resultJson: { toolCallCount } };
      }
      messages.push({ role: "assistant", content: turn.content,
        tool_calls: turn.toolCalls.map((call) => ({ id: call.id, type: "function" as const,
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });
      for (const call of turn.toolCalls) {
        toolCallCount += 1;
        if (toolCallCount > MAX_TOOL_CALLS) throw new Error("App-managed Splash tool call limit reached.");
        await ctx.onLog("stdout", `${JSON.stringify({ type: "tool_call", name: call.name })}\n`);
        let result: string;
        let isError = false;
        try {
          result = await executor.execute(call);
        } catch (error) {
          if (error instanceof UncertainPaperclipMutationError || error instanceof InterruptedCodingCommandError) throw error;
          isError = true;
          result = JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 1024) : "Tool failed." });
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: result.slice(0, 65_536) });
        await ctx.onLog("stdout", `${JSON.stringify({ type: "tool_result", name: call.name, isError })}\n`);
      }
    }
    throw new Error("App-managed Splash step limit reached before a final response.");
  } finally {
    release();
  }
}
