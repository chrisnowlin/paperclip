import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult, RuntimeStatusPhase } from "@paperclipai/adapter-utils";
import { buildPaperclipEnv, joinPromptSections, renderPaperclipWakePrompt, selectPaperclipTaskMarkdown } from "@paperclipai/adapter-utils/server-utils";
import { completeLmStudioTurn, LMSTUDIO_SPLASH_MODEL, probeLmStudioSplash, readSplashProgress, type LmStudioMessage } from "./model.js";
import { assertLmStudioSplashConfig } from "./profile.js";
import { splashRunQueue } from "./run-queue.js";
import { createLmStudioToolExecutor, InterruptedCodingCommandError, UncertainPaperclipMutationError } from "./tools.js";

const MAX_TOOL_CALLS = 48;
const MAX_RUN_MS = 2 * 60 * 60 * 1_000;
const MAX_QUEUE_WAIT_MS = 2 * 60 * 60 * 1_000;
const WATCHDOG_SETUP_TIMEOUT_MS = 5_000;
const ACTIONLESS_TURN_REVIEW_MS = 8 * 60_000;
const ACTIONLESS_TURN_REVIEW_TOKENS = 20_000;
const ACTIONLESS_REFOCUS_MS = 4 * 60_000;
const ACTIONLESS_REFOCUS_TOKENS = 10_000;
const ISSUE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVOKABLE_LOCAL_MANAGER_STATUSES = new Set(["active", "idle", "running", "error"]);
type TaskSkipReason = "done" | "cancelled" | "blocked" | "reassigned";

export function actionlessTurnExhausted(elapsedMs: number, generatedTokens: number, reasoningChars: number,
  toolDraftAgeMs = Number.POSITIVE_INFINITY): boolean {
  if (toolDraftAgeMs < 60_000) return false;
  return elapsedMs >= ACTIONLESS_TURN_REVIEW_MS &&
    Math.max(generatedTokens, Math.floor(reasoningChars / 4)) >= ACTIONLESS_TURN_REVIEW_TOKENS;
}

export function actionlessTurnNeedsRefocus(elapsedMs: number, generatedTokens: number, reasoningChars: number,
  toolDraftAgeMs = Number.POSITIVE_INFINITY): boolean {
  if (toolDraftAgeMs < 60_000) return false;
  return elapsedMs >= ACTIONLESS_REFOCUS_MS &&
    Math.max(generatedTokens, Math.floor(reasoningChars / 4)) >= ACTIONLESS_REFOCUS_TOKENS;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function taskSkipReason(source: Record<string, unknown>, issueId: string, agentId: string): TaskSkipReason | null {
  if (source.id !== issueId) return null;
  if (Array.isArray(source.blockedBy) && source.blockedBy.some((blocker) => record(blocker).status !== "done")) return "blocked";
  if (source.status === "done" || source.status === "cancelled" || source.status === "blocked") return source.status;
  if (typeof source.assigneeAgentId === "string" && source.assigneeAgentId !== agentId) return "reassigned";
  return null;
}

function dispositionToolAllowed(call: { name: string; arguments: Record<string, unknown> }, issueId: string): boolean {
  if (call.name !== "paperclip_request") return false;
  const issuePath = `/api/issues/${issueId}`;
  const method = call.arguments.method;
  const path = call.arguments.path;
  return (method === "GET" && (path === issuePath || path === `${issuePath}/comments`)) ||
    (method === "PATCH" && path === issuePath) ||
    (method === "POST" && path === `${issuePath}/comments`);
}

async function readTaskSkipReason(input: { apiUrl: string; issueId: string | null; agentId: string;
  authToken: string; signal: AbortSignal }): Promise<TaskSkipReason | null> {
  if (!input.issueId || !ISSUE_ID_PATTERN.test(input.issueId)) return null;
  const base = input.apiUrl.endsWith("/") ? input.apiUrl : `${input.apiUrl}/`;
  try {
    const response = await fetch(new URL(`api/issues/${input.issueId}`, base).toString(), {
      headers: { Authorization: `Bearer ${input.authToken}` },
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(WATCHDOG_SETUP_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error("Task state unavailable.");
    const source = record(await response.json());
    if (source.id !== input.issueId) throw new Error("Task state mismatch.");
    return taskSkipReason(source, input.issueId, input.agentId);
  } catch {
    throw new Error("Paperclip task state could not be confirmed; no further local model tool was run.");
  }
}

async function skippedTaskResult(ctx: AdapterExecutionContext, reason: TaskSkipReason,
  usage: { inputTokens: number; outputTokens: number }): Promise<AdapterExecutionResult> {
  await ctx.onLog("stdout", `${JSON.stringify({ type: "skipped_stale_task", reason })}\n`);
  return { exitCode: 0, signal: null, timedOut: false, provider: "splash", biller: "local",
    model: LMSTUDIO_SPLASH_MODEL, billingType: "fixed", costUsd: 0, usageBasis: "per_run",
    usage, sessionId: null, sessionParams: null, sessionDisplayId: null, clearSession: true,
    summary: `The task became ${reason} during local Splash execution; no further model tool was run.`,
    resultJson: { skippedStaleTask: reason } };
}

async function preflightLocalTaskAndWatchdog(input: {
  apiUrl: string;
  issueId: string | null;
  agentId: string;
  companyId: string;
  managerId: string | null;
  authToken: string;
  signal: AbortSignal;
}): Promise<{ watchdogReady: boolean; skipReason: TaskSkipReason | null }> {
  if (!input.issueId || !ISSUE_ID_PATTERN.test(input.issueId)) return { watchdogReady: true, skipReason: null };
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(WATCHDOG_SETUP_TIMEOUT_MS)]);
  const base = input.apiUrl.endsWith("/") ? input.apiUrl : `${input.apiUrl}/`;
  const issueUrl = new URL(`api/issues/${input.issueId}`, base);
  const watchdogUrl = new URL(`api/issues/${input.issueId}/watchdog`, base);
  const headers = { Authorization: `Bearer ${input.authToken}` };
  try {
    const sourceResponse = await fetch(issueUrl.toString(), { headers, signal });
    if (!sourceResponse.ok) return { watchdogReady: false, skipReason: null };
    const source = record(await sourceResponse.json());
    if (source.id !== input.issueId) return { watchdogReady: false, skipReason: null };
    const skipReason = taskSkipReason(source, input.issueId, input.agentId);
    if (skipReason) return { watchdogReady: true, skipReason };
    if (source.originKind === "task_watchdog") return { watchdogReady: true, skipReason: null };
    const existingResponse = await fetch(watchdogUrl.toString(), { headers, signal });
    if (!existingResponse.ok) return { watchdogReady: false, skipReason: null };
    if (await existingResponse.json() !== null) return { watchdogReady: true, skipReason: null };
    let watchdogAgentId = input.agentId;
    if (input.managerId && ISSUE_ID_PATTERN.test(input.managerId) && input.managerId !== input.agentId) {
      try {
        const managerResponse = await fetch(new URL(`api/agents/${input.managerId}`, base).toString(), { headers, signal });
        if (managerResponse.ok) {
          const manager = record(await managerResponse.json());
          if (manager.id === input.managerId && manager.companyId === input.companyId &&
            manager.adapterType === "lmstudio_splash_local" && INVOKABLE_LOCAL_MANAGER_STATUSES.has(String(manager.status))) {
            watchdogAgentId = input.managerId;
          }
        }
      } catch { /* an unavailable manager leaves the local worker as the fallback */ }
    }
    const created = await fetch(watchdogUrl.toString(), { method: "PUT", signal,
      headers: { ...headers, "Content-Type": "application/json", "X-Paperclip-Create-Only": "true" },
      body: JSON.stringify({ agentId: watchdogAgentId,
        instructions: "Review this stopped local Splash task and its existing work. If a run made no durable progress, the replacement must be demonstrably smaller: choose exactly one module, pure function, or single interaction plus its finite check. Do not restate a multi-stage feature as one child or bundle the original requirements into a priority list. Preserve files, create only that narrow local child in the same project workspace with a first-class blocker, and record the deferred requirements for later company tasks. Verify before marking done. Do not retry the same scope indefinitely or route private source to a remote provider." }),
    });
    return { watchdogReady: created.ok, skipReason: null };
  } catch {
    return { watchdogReady: false, skipReason: null };
  }
}

function systemGuidance(role: string | undefined): string {
  const base = "You are a local Paperclip coding agent. Use the provided tools for workspace and task actions. Run only commands that exit; a foreground dev server times out and aborts your task. Use a production build for bounded verification and ask the board to check the browser when needed. When a task delivers a file, use register_deliverable for the finished workspace file and include its returned downloadPath in the final task comment. Never request credentials or alternate model endpoints. Keep local task details with app-managed Splash agents; do not assign a child to a remote or paid-provider agent without explicit board authorization and a named account binding. For a parent issue resumed after children finish, compare each original parent acceptance criterion with the child scopes and committed evidence; child status alone does not prove the parent is complete. Record any gap and assign one bounded local follow-up with a first-class blocker before closing the parent. Report completed work clearly before the model-step limit.";
  if (role === "cto" || role === "ceo") return `${base} If the current issue asks for implementation, implement its scoped deliverable yourself after brief inspection, run a finite check, and report the result; your coordinator title is not a request to delegate that work. Only when the issue asks for coordination or decomposition, first inspect the issue and existing child issues. As CTO, you may use hire_coder for up to three new coders in one staffing turn, choosing only app-managed local Splash or the exact zai-coding-plan/glm-5.3-flash OpenCode route. Use hire_coder rather than paperclip_request to create agents. Record each hire's route and each task-to-agent decision; do not rotate accounts or silently fall back. For multiple independently verifiable deliverables, create at most three narrow child issues with explicit assignees, one deliverable and one acceptance check each. Give each local coding child the parent's project and project workspace at creation; create dependencies in the same request so a child cannot wake before its blocker finishes. Record the task-to-agent decision in a parent comment. Keep the parent blocked on unfinished children through first-class blocker links, and verify their results before marking the parent done. Configure a task watchdog on the coordinating parent with a different same-company local agent so a stopped subtree gets reviewed; never give the watchdog a paid-provider account or private source through a remote agent. Do not duplicate existing children or implement child work in that coordination turn. Use an idempotency key for every task creation.`;
  return `${base} Complete one scoped deliverable at a time. If the assignment spans several independent deliverables, land the smallest verifiable slice first, report exactly what remains to the coordinator, and avoid starting unrelated work. If a turn has made no tool progress, make the next action a bounded read, write, or task update rather than extending private reasoning indefinitely.`;
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
  const reportQueueStatus = async (message: string, phase: RuntimeStatusPhase = "adapter_startup") => {
    try { await ctx.onRuntimeProgress?.({ phase, message }); }
    catch { /* progress reporting must not prevent local work */ }
  };
  let queuedProgress: Promise<void> | null = null;
  let queueStatusTimer: ReturnType<typeof setInterval> | null = null;
  const release = await splashRunQueue.acquire(queueSignal, (position) => {
    queuedProgress = reportQueueStatus(`Queued for the local Splash model (joined at position ${position}).`, "local_model_wait");
    // Runtime status expires after 90 seconds. Refresh the wait state so a
    // healthy serial queue does not look like a disconnected provider run.
    queueStatusTimer = setInterval(() => {
      void reportQueueStatus("Waiting for the local Splash model; another local run has the slot.", "local_model_wait");
    }, 30_000);
  }).finally(() => {
    if (queueStatusTimer) clearInterval(queueStatusTimer);
  });
  try {
    if (queuedProgress) await queuedProgress;
    await reportQueueStatus("Local Splash model slot acquired.");
    const runSignal = ctx.signal
      ? AbortSignal.any([ctx.signal, AbortSignal.timeout(MAX_RUN_MS)])
      : AbortSignal.timeout(MAX_RUN_MS);
    const apiUrl = buildPaperclipEnv(ctx.agent).PAPERCLIP_API_URL;
    const issueId = typeof ctx.context.taskId === "string" ? ctx.context.taskId : null;
    const dispositionOnly = ctx.context.wakeReason === "finish_successful_run_handoff";
    if (dispositionOnly && (!issueId || !ISSUE_ID_PATTERN.test(issueId))) {
      throw new Error("Disposition-only Splash run is missing its source issue.");
    }
    const taskPreflight = await preflightLocalTaskAndWatchdog({
      apiUrl, issueId,
      agentId: ctx.agent.id, companyId: ctx.agent.companyId,
      managerId: ctx.agent.reportsTo ?? null, authToken: ctx.authToken, signal: runSignal,
    });
    if (taskPreflight.skipReason) {
      return skippedTaskResult(ctx, taskPreflight.skipReason, { inputTokens: 0, outputTokens: 0 });
    }
    if (!taskPreflight.watchdogReady) {
      await reportQueueStatus("Local task watchdog setup was unavailable; this run continues and task recovery needs review.");
    }
    const executor = await createLmStudioToolExecutor({ workspace: cwd, companyId: ctx.agent.companyId,
      taskId: issueId,
      runId: ctx.runId, authToken: ctx.authToken, apiUrl, signal: runSignal, onSpawn: ctx.onSpawn,
      ctoAgentId: ctx.agent.role === "cto" ? ctx.agent.id : undefined,
      hireWorkspaceRoot: ctx.agent.role === "cto" && typeof ctx.config.cwd === "string"
        ? path.dirname(ctx.config.cwd) : undefined });
    const issueDispositionTools = issueId && ISSUE_ID_PATTERN.test(issueId) ? executor.definitions
      .filter((definition) => definition.function.name === "paperclip_request")
      .map((definition) => ({ ...definition, function: {
        ...definition.function,
        description: `Disposition only: GET /api/issues/${issueId} or its /comments; PATCH that issue; POST a comment there. Workspace tools and other Paperclip paths are unavailable.`,
        parameters: { ...definition.function.parameters, properties: {
          method: { type: "string", enum: ["GET", "POST", "PATCH"] },
          path: { type: "string", enum: [`/api/issues/${issueId}`, `/api/issues/${issueId}/comments`] },
          body: { type: "object" },
        } },
      } })) : [];
    const modelTools = dispositionOnly ? issueDispositionTools : executor.definitions;
    const wake = renderPaperclipWakePrompt(ctx.context.paperclipWake);
    const task = selectPaperclipTaskMarkdown(ctx.context);
    const prompt = joinPromptSections([wake, task, typeof ctx.config.promptTemplate === "string" ? ctx.config.promptTemplate : ""]);
    if (!prompt) throw new Error("App-managed Splash received no task context.");
    await ctx.onMeta?.({ adapterType: "lmstudio_splash_local", command: "Bundled Splash local API", cwd,
      commandNotes: ["Fixed model and loopback endpoint; no provider session or paid account."], prompt });
    const messages: LmStudioMessage[] = [
      { role: "system", content: dispositionOnly
        ? `${systemGuidance(ctx.agent.role)} This is a disposition-only follow-up. Use only paperclip_request on this source issue. Do not inspect or change workspace files or run commands.`
        : systemGuidance(ctx.agent.role) },
      { role: "user", content: prompt },
    ];
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCallCount = 0;
    let dispatched = false;
    let refocusAttempts = 0;
    for (let step = 0; step < maxSteps; step += 1) {
      if (runSignal.aborted) throw new Error("App-managed Splash run was cancelled or timed out.");
      const finalizationOnly = !dispositionOnly && issueId !== null && ISSUE_ID_PATTERN.test(issueId) &&
        step === maxSteps - 1;
      const turnTools = finalizationOnly ? issueDispositionTools : modelTools;
      if (step === maxSteps - 3) {
        const taskPath = issueId && ISSUE_ID_PATTERN.test(issueId)
          ? `/api/issues/${issueId}` : "the current Paperclip task";
        messages.push({ role: "system", content:
          `Only three local model turns remain in this run. Stop broad inspection and do not start a new deliverable. Preserve coherent work, run one finite check if needed, then use paperclip_request to record the task's real disposition at ${taskPath}: done with evidence, or blocked/in_review with the exact remaining owner and action. A comment or final prose alone is not a task disposition. Return a concise final response before the step limit; never claim unverified work is done.` });
      }
      if (finalizationOnly) {
        messages.push({ role: "system", content:
          `This is the last local model turn. Workspace tools are disabled. Do not start or revise code. Use paperclip_request to PATCH /api/issues/${issueId} to the real disposition: done only with verified evidence, or blocked/in_review with the exact remaining owner and action. A comment or final prose alone does not set status. If work remains, preserve the existing files for review.` });
      }
      const staleBeforeTurn = await readTaskSkipReason({ apiUrl, issueId, agentId: ctx.agent.id,
        authToken: ctx.authToken, signal: runSignal });
      if (staleBeforeTurn) return skippedTaskResult(ctx, staleBeforeTurn, { inputTokens, outputTokens });
      await probeLmStudioSplash(fetch, runSignal);
      if (!dispatched) { ctx.onDispatch?.(); dispatched = true; }
      await reportQueueStatus(`Splash step ${step + 1}/${maxSteps} is generating locally; a turn can take several minutes.`, "run_activity");
      const turnStarted = Date.now();
      const progressBaseline = await readSplashProgress(fetch, runSignal);
      let budget: { promptTokens: number; maxOutputTokens: number } | null = null;
      let lastGenerated = 0;
      let reasoningTail = "";
      let reasoningChars = 0;
      let toolDraft: { name: string; argumentChars: number; updatedAt: number } | null = null;
      const actionlessAbort = new AbortController();
      let actionlessAbortReason: "refocus" | "scope_stall" | null = null;
      const turnSignal = AbortSignal.any([runSignal, actionlessAbort.signal]);
      let turnActive = true;
      let progressPending = false;
      const progressTimer = setInterval(() => {
        if (!turnActive || progressPending) return;
        progressPending = true;
        void (async () => {
          const current = await readSplashProgress(fetch, runSignal);
          if (!turnActive) return;
          if (current?.decodeTokens !== null && current?.decodeTokens !== undefined &&
              progressBaseline?.decodeTokens !== null && progressBaseline?.decodeTokens !== undefined) {
            lastGenerated = Math.max(lastGenerated, current.decodeTokens - progressBaseline.decodeTokens);
          }
          const toolDraftAgeMs = toolDraft ? Date.now() - toolDraft.updatedAt : Number.POSITIVE_INFINITY;
          const localRoleRefocus = (ctx.agent.role === "cto" || ctx.agent.role === "ceo" ||
            ctx.agent.role === "engineer") &&
            actionlessTurnNeedsRefocus(Date.now() - turnStarted, lastGenerated, reasoningChars, toolDraftAgeMs);
          if (localRoleRefocus && !actionlessAbort.signal.aborted) {
            actionlessAbortReason = refocusAttempts === 0 ? "refocus" : "scope_stall";
            actionlessAbort.abort();
            return;
          }
          if (actionlessTurnExhausted(Date.now() - turnStarted, lastGenerated, reasoningChars, toolDraftAgeMs) &&
              !actionlessAbort.signal.aborted) {
            actionlessAbortReason = "scope_stall";
            actionlessAbort.abort();
            return;
          }
          const elapsed = Math.max(1, Math.floor((Date.now() - turnStarted) / 60_000));
          const prefillDelta = current?.prefillTokens !== null && current?.prefillTokens !== undefined &&
            progressBaseline?.prefillTokens !== null && progressBaseline?.prefillTokens !== undefined
            ? Math.max(0, current.prefillTokens - progressBaseline.prefillTokens) : null;
          const preparing = current?.prefilling === true && lastGenerated === 0;
          const count = preparing
            ? prefillDelta === null ? "preparing context" : `preparing context · ~${prefillDelta.toLocaleString("en-US")} input tokens processed`
            : current?.decodeTokens == null ? "token count unavailable" : `~${lastGenerated.toLocaleString("en-US")} generated tokens`;
          const limit = !preparing && budget ? ` / ${budget.maxOutputTokens.toLocaleString("en-US")} allowance` : "";
          const excerpt = reasoningTail.replace(/\s+/g, " ").trim().slice(-90);
          const activity = toolDraft && toolDraftAgeMs < 60_000
            ? ` · assembling ${toolDraft.name} (${toolDraft.argumentChars.toLocaleString("en-US")} chars)`
            : excerpt ? ` · thinking: ${excerpt}` : "";
          await reportQueueStatus(`Splash step ${step + 1}/${maxSteps} · ${count}${limit} · ${elapsed}m${activity}`, "run_activity");
        })().finally(() => { progressPending = false; });
      }, 15_000);
      progressTimer.unref();
      let turn: Awaited<ReturnType<typeof completeLmStudioTurn>>;
      try { turn = await completeLmStudioTurn({ messages, tools: turnTools, signal: turnSignal, stream: true,
        onReasoningDelta: (delta) => { reasoningTail = (reasoningTail + delta).slice(-160); reasoningChars += delta.length; },
        onToolDraftProgress: (progress) => {
          const name = turnTools.some((definition) => definition.function.name === progress.name)
            ? progress.name! : "tool";
          toolDraft = { name, argumentChars: progress.argumentChars, updatedAt: Date.now() };
        },
        onTokenBudget: async (measured) => {
          budget = measured;
          await reportQueueStatus(`Splash step ${step + 1}/${maxSteps} prompt: ${measured.promptTokens.toLocaleString("en-US")} tokens; output allowance: ${measured.maxOutputTokens.toLocaleString("en-US")} tokens.`, "run_activity");
        } }); }
      catch (error) {
        if (actionlessAbort.signal.aborted && !runSignal.aborted) {
          const generatedEstimate = Math.max(lastGenerated, Math.floor(reasoningChars / 4));
          if (actionlessAbortReason === "refocus") {
            refocusAttempts += 1;
            await ctx.onLog("stdout", `${JSON.stringify({ type: "scope_refocus", generatedTokensEstimate: generatedEstimate,
              elapsedMinutes: Math.floor((Date.now() - turnStarted) / 60_000), step: step + 1 })}\n`);
            messages.push({ role: "system", content: "Your previous turn used substantial local reasoning without a task action. Do not restate or extend that plan. On this turn, call one appropriate Paperclip task tool now to record a concrete decision or create the single bounded child you already identified. If you cannot act safely, record the exact blocker on the current issue. This is the only automatic refocus attempt; another actionless turn will stop the run." });
            continue;
          }
          await ctx.onLog("stdout", `${JSON.stringify({ type: "scope_stall", generatedTokens: generatedEstimate,
            elapsedMinutes: Math.floor((Date.now() - turnStarted) / 60_000), step: step + 1 })}\n`);
          throw new Error("Splash made no task-tool progress after a substantial local reasoning budget. Review this task's scope, preserve existing work, and split the next deliverable before retrying; no alternate provider was tried.");
        }
        throw error;
      }
      finally { turnActive = false; clearInterval(progressTimer); }
      inputTokens += turn.usage.inputTokens;
      outputTokens += turn.usage.outputTokens;
      const stale = await readTaskSkipReason({ apiUrl, issueId, agentId: ctx.agent.id,
        authToken: ctx.authToken, signal: runSignal });
      if (stale) return skippedTaskResult(ctx, stale, { inputTokens, outputTokens });
      if (turn.toolCalls.length === 0) {
        if (finalizationOnly) throw new Error("App-managed Splash final step ended without a task disposition.");
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
      let taskDisposition: "done" | "blocked" | "in_review" | "cancelled" | null = null;
      for (const call of turn.toolCalls) {
        const staleBeforeTool = await readTaskSkipReason({ apiUrl, issueId, agentId: ctx.agent.id,
          authToken: ctx.authToken, signal: runSignal });
        if (staleBeforeTool) return skippedTaskResult(ctx, staleBeforeTool, { inputTokens, outputTokens });
        toolCallCount += 1;
        if (toolCallCount > MAX_TOOL_CALLS) throw new Error("App-managed Splash tool call limit reached.");
        await ctx.onLog("stdout", `${JSON.stringify({ type: "tool_call", name: call.name })}\n`);
        let result: string;
        let isError = false;
        try {
          if ((dispositionOnly || finalizationOnly) && !dispositionToolAllowed(call, issueId!)) {
            throw new Error("Disposition-only turn can only read or update its source Paperclip issue.");
          }
          result = await executor.execute(call);
        } catch (error) {
          if (error instanceof UncertainPaperclipMutationError || error instanceof InterruptedCodingCommandError) throw error;
          isError = true;
          result = JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 1024) : "Tool failed." });
        }
        if (finalizationOnly && !isError && call.name === "paperclip_request" &&
            call.arguments.method === "PATCH" && call.arguments.path === `/api/issues/${issueId}`) {
          let patched: Record<string, unknown>;
          try { patched = record(JSON.parse(result)); }
          catch { throw new UncertainPaperclipMutationError(); }
          if (patched.id !== issueId || !["done", "blocked", "in_review", "cancelled"].includes(String(patched.status))) {
            throw new UncertainPaperclipMutationError();
          }
          taskDisposition = patched.status as typeof taskDisposition;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: result.slice(0, 65_536) });
        await ctx.onLog("stdout", `${JSON.stringify({ type: "tool_result", name: call.name, isError })}\n`);
      }
      if (finalizationOnly) {
        if (!taskDisposition) throw new Error("App-managed Splash final step ended without a verified task disposition.");
        return { exitCode: 0, signal: null, timedOut: false, provider: "splash", biller: "local",
          model: LMSTUDIO_SPLASH_MODEL, billingType: "fixed", costUsd: 0, usageBasis: "per_run",
          usage: { inputTokens, outputTokens }, sessionId: null, sessionParams: null,
          sessionDisplayId: null, clearSession: true,
          summary: `The task was marked ${taskDisposition} on the final local Splash step.`,
          resultJson: { toolCallCount, taskDisposition } };
      }
    }
    throw new Error("App-managed Splash step limit reached before a final response.");
  } finally {
    release();
  }
}
