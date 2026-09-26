# Direct LM Studio Splash agent for Paperclip Standalone V2

Status: implementation design · 2026-09-26

## Intent and boundary

Paperclip V2 should run the local `incoai/Qwen3.8-27B-Splash` model through LM Studio's loopback API without OpenCode, Codex, or a paid provider account. Paperclip supplies the agent loop and tools. The initial agent is an owner for local-trusted coding tasks, including delegated child issues and comment wakes. V2's reviewer still requires an active sandbox and cannot use this local-only adapter.

LM Studio currently serves `127.0.0.1:1234`; its native model list identifies `qwen3.8-27b-splash` as `format: splash`, but reports no loaded instance. A listed download is not readiness. The adapter requires that exact model to be loaded before every model request; it never calls LM Studio's load or download API. Live qualification must disable just-in-time loading or pin the instance loaded, because a model could unload between readiness and inference. The standalone Splash server on port 8000 is separate and is not part of this route.

## Runtime

Add one built-in `lmstudio_splash_local` adapter. Its endpoint and model are fixed: `http://127.0.0.1:1234/v1/chat/completions` and `qwen3.8-27b-splash`. Only a local execution target is allowed. The adapter accepts no AI Connection, arbitrary base URL, model override, auth override, or inherited paid-provider key. A failed readiness check, malformed response, timeout, or LM Studio shutdown fails the run with a clear diagnostic and no fallback. Readiness reads `/api/v1/models` and requires the model's `format` to be `splash` and `loaded_instances` to be nonempty. Model loading remains an explicit operator action.

Each heartbeat starts a bounded in-memory conversation from Paperclip's authoritative task/wake context. There is no claimed provider-session continuity between heartbeats. Within a heartbeat, the adapter sends OpenAI-compatible chat-completion requests with tool definitions, executes validated tool calls, appends results, and repeats until the model gives a final answer or the limit is reached. Every model request and tool action is bounded by the run signal, a per-call timeout, size limits, and a maximum step/tool count. Usage is accumulated from LM Studio responses; local model cost is recorded as zero. The adapter emits a readable transcript and returns a normal `AdapterExecutionResult` without persisting prompts or secrets in a separate credential store.

## Tools and authority

The local-trusted owner receives five Paperclip-owned tools: list workspace files, read a file, write a file atomically, run a command with argv and a fixed invocation cwd, and make a run-authenticated Paperclip task request. File tools reject absolute paths, `..`, symlink escapes, and files outside the selected workspace. Reads, writes, command duration, command output, HTTP response size, and tool count have explicit ceilings. `run_command` executes on the local host with the same OS-user authority as existing local coding agents; a command can access files outside the workspace, so this is a local-trusted owner capability, not an OS sandbox. Its process is registered for run cancellation. The reviewer path does not receive this adapter.

The Paperclip request tool calls only the server-derived loopback API URL and a company-scoped task/agent path allowlist. It uses the run JWT out of band and includes `X-Paperclip-Run-Id` on mutations. Existing route authorization, approval, activity, single-assignee, and issue-checkout rules remain authoritative. The model never receives the JWT. A failed or uncertain mutation is surfaced as such; the adapter does not silently retry a non-idempotent request. Task creation requires an idempotency key. Tool output is truncated before returning to the model or run log, and logs avoid raw credentials and full tool arguments.

The adapter only executes within the workspace Paperclip selected for the task. It cannot choose a different directory from a model tool call. The coding pod continues to pin the owner, reviewer, and candidate SHA; this adapter changes only the owner's execution harness. Candidate capture, reviewer sandbox, approval, budget, and recovery gates remain unchanged. Pod configuration rejects the direct local adapter as reviewer.

## Integration and qualification

Register the adapter in server, UI, CLI, and macOS local setup. The macOS picker shows the LM Studio Splash route without a provider login and reports downloaded-versus-loaded readiness. Agent configuration names the fixed model and endpoint rather than offering a paid-provider selector. V1/V2 bundle identities, ports, and data directories remain unchanged. No database migration or second AI credential system is needed.

Focused tests use a fake LM Studio HTTP server and temporary Git workspaces to prove exact routing, tool call/result cycles, delegated task and comment wakes, file containment, command timeout/cancellation, company-scoped Paperclip API calls, malformed responses, endpoint failure, step limits, and no paid fallback. Live qualification requires the operator to load the Splash model in LM Studio and authorize a disposable Paperclip agent run; no live agent or provider account is used while implementing this adapter.
