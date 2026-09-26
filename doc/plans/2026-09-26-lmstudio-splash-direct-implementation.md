# Direct LM Studio Splash Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run V2 local coding and delegated tasks through LM Studio Splash with a Paperclip-owned tool loop and no OpenCode or paid-account fallback.

**Architecture:** A new local-only `lmstudio_splash_local` adapter calls LM Studio's fixed loopback Chat Completions endpoint. Its tool loop delegates bounded workspace and Paperclip API operations to small local tool modules. V2 governance and the issue/coding-pod records remain authoritative.

**Tech Stack:** Node.js 24+, TypeScript, Express, Vitest, React/Vite, SwiftPM/AppKit, LM Studio OpenAI-compatible and native model-list APIs.

**Spec:** `doc/plans/2026-09-26-lmstudio-splash-direct-design.md`

## Global Constraints

- Preserve installed app `3317`, V1 `3318`, V2 `3319`, V2 PostgreSQL `54333`, and their data directories.
- Never start a Paperclip agent, send inference, or use a paid provider account during implementation tests.
- Require `qwen3.8-27b-splash` in loaded LM Studio instances at `127.0.0.1:1234`; no JIT load, network endpoint override, or paid fallback.
- Local-trusted owner only. V2 reviewer remains sandboxed and separate. Paperclip's task auth, budget, approval, activity, and checkout gates remain in force.
- Any UI values use `ui/src/index.css` tokens; run `pnpm check:token-gates`.

## Review Focus

1. `/v1/models` may list an unloaded model: readiness must use native `loaded_instances` and reject unloaded Splash.
2. A malformed tool call or path may target another company or leave the workspace: validate before execution.
3. A tool or LM Studio request may hang after Stop: abort and settle within the run's bounds.
4. A lost mutation response may be retried: require idempotency on task creation and do not auto-repeat uncertain writes.
5. Ambient OpenAI/Claude credentials or an endpoint change may route to a paid account: keep endpoint/model fixed and mask keys.

### Task 1: Model route and response parser

**Files:** Create `packages/adapters/lmstudio-splash-local/src/server/model.ts`, `model.test.ts`, package exports and metadata.

**Interfaces:** `probeLmStudioSplash(fetcher): Promise<readiness>` queries `/api/v1/models` and returns only the exact loaded Splash model. `completeLmStudioTurn(messages, tools, signal, fetcher)` calls fixed `/v1/chat/completions` and parses content, tool calls, and usage with size/time bounds.

- [x] Write tests for loaded/unloaded/wrong-format model, unavailable endpoint, malformed completion, tool call and usage parsing, and no alternate host/model.
- [x] Run the focused test and confirm failures, implement the two functions, rerun green.
- [x] Commit the model route.

### Task 2: Local coding and task tools

**Files:** Create `packages/adapters/lmstudio-splash-local/src/server/tools.ts`, `tools.test.ts`.

**Interfaces:** `createLmStudioToolExecutor({workspace,companyId,runId,authToken,apiUrl,signal,onSpawn})` exposes fixed JSON tool definitions and `execute(call)`. File paths stay within workspace; commands use fixed cwd and bounded argv/time/output; Paperclip requests use a company/task allowlist and run headers.

- [x] Write failing tests for file read/write/list, path and symlink escape, command bounds/cancellation, company path rejection, JWT never in model output, and mutation retry behavior.
- [x] Implement the bounded local tool executor against the existing Paperclip API authority; rerun focused tests.
- [x] Commit the tool boundary.

### Task 3: Heartbeat loop and adapter registration

**Files:** Create `packages/adapters/lmstudio-splash-local/src/server/execute.ts`, `test.ts`, UI and CLI parsers; register in `server/src/adapters/registry.ts`, `server/src/adapters/builtin-adapter-types.ts`, UI/CLI registries, workspace/package manifests, and local environment support. No `session.ts` is needed because each run is stateless.

**Interfaces:** `execute(ctx)` builds the Paperclip wake prompt, runs a bounded model/tool loop, emits redacted progress and usage, handles Stop, and returns a normal `AdapterExecutionResult` without a claimed cross-heartbeat session. `testEnvironment(ctx)` checks readiness without inference.

- [x] Write failing adapter tests for delegated assignment, comment wake, multi-tool cycle, final response, cancellation, limits, and no paid fallback.
- [x] Implement the loop and register the adapter across server/UI/CLI; run focused tests and targeted typechecks.
- [x] Commit the adapter integration.

### Task 4: V2 setup and pod qualification

**Files:** Extend `macos/PaperclipStandaloneDev/Sources/PaperclipStandaloneDev/LocalAgentSetupController.swift`, its Swift tests, `server/src/services/coding-pods.ts` and route tests, and the decision docs.

**Interfaces:** Native setup offers direct LM Studio Splash without sign-in. A project pod accepts it as local owner and rejects it as sandboxed reviewer. Pod attachment keeps the existing task-to-agent/account audit.

- [x] Write failing Swift and pod tests for setup/readiness and owner/reviewer selection.
- [x] Implement setup and pod validation; run focused tests and Swift build/tests.
- [x] Run token gates, repository typecheck, focused tests, Swift tests, and repository build. The full `pnpm test:run` gate was attempted and stopped after existing OpenAI AI Connection tests failed because their project-auth scan sees the host's ancestor `~/.codex/config.toml`. The full suite remains unverified from this worktree; AI Connection runtime code was not changed.
- [x] Commit and report the remaining live qualification: explicit LM Studio load, disposable agent task, delegation, Stop, and V1/V2 isolation.
