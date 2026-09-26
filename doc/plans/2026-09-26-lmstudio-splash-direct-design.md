# Direct LM Studio Splash agent for Paperclip Standalone V2

Status: implemented; live inference qualification pending · 2026-09-26

## Intent and boundary

Paperclip V2 should run the local `incoai/Qwen3.8-27B-Splash` model through LM Studio's loopback API without OpenCode, Codex, or a paid provider account. Paperclip supplies the agent loop and tools. The initial agent is an owner for local-trusted coding tasks, including delegated child issues and comment wakes. V2's reviewer still requires an active sandbox and cannot use this local-only adapter.

LM Studio currently serves `127.0.0.1:1234`; its native model list identifies `qwen3.8-27b-splash` as `format: splash`, but reports no loaded instance. A listed download is not readiness. The adapter requires that exact model to be loaded before every model request; it never calls LM Studio's load or download API. Live qualification must disable just-in-time loading or pin the instance loaded, because a model could unload between readiness and inference. The standalone Splash server on port 8000 is separate and is not part of this route.

## Runtime

Add one built-in `lmstudio_splash_local` adapter. Its endpoint and model are fixed: `http://127.0.0.1:1234/v1/chat/completions` and `qwen3.8-27b-splash`. Only a local execution target is allowed. The adapter accepts no AI Connection, arbitrary base URL, model override, auth override, or inherited paid-provider key. A failed readiness check, malformed response, timeout, or LM Studio shutdown fails the run with a clear diagnostic and no fallback. Readiness reads `/api/v1/models` and requires the model's `format` to be `splash` and `loaded_instances` to be nonempty. Model loading remains an explicit operator action.

Each heartbeat starts a bounded in-memory conversation from Paperclip's authoritative task/wake context. There is no claimed provider-session continuity between heartbeats. Within a heartbeat, the adapter sends OpenAI-compatible chat-completion requests with tool definitions, executes validated tool calls, appends results, and repeats until the model gives a final answer or the limit is reached. Every model request and tool action is bounded by the run signal, a per-call timeout, size limits, and a maximum step/tool count. Usage is accumulated from LM Studio responses; local model cost is recorded as zero. The adapter emits a readable transcript and returns a normal `AdapterExecutionResult` without persisting prompts or secrets in a separate credential store.

The V2 server admits only **one Splash agent run at a time**. Up to three additional runs wait in FIFO order; the run log shows each waiter's position when it joined and when it acquires the slot. Waiting is bounded to ten minutes, and Stop removes a waiting run immediately. A fourth waiter receives an explicit queue-full failure and can be retried after capacity clears. The slot covers the whole model/tool loop, including commands, so delegated tasks cannot interleave their local inference or workspace actions. The active run has a separate ten-minute limit and always releases the slot on success, failure, or Stop. This queue governs this V2 server process; other applications using LM Studio are outside Paperclip's control.

## Tools and authority

The local-trusted owner receives five Paperclip-owned tools: list workspace files, read a file, write a file atomically, run a command with argv and a fixed invocation cwd, and make a run-authenticated Paperclip task request. File tools reject absolute paths, `..`, symlink escapes, and files outside the selected workspace. Reads, writes, command duration, command output, HTTP response size, and tool count have explicit ceilings. `run_command` executes on the local host with the same OS-user authority as existing local coding agents; a command can access files outside the workspace, so this is a local-trusted owner capability, not an OS sandbox. Its process is registered for run cancellation. The reviewer path does not receive this adapter.

The Paperclip request tool calls only the server-derived loopback API URL and a company-scoped task/agent path allowlist. It uses the run JWT out of band and includes `X-Paperclip-Run-Id` on mutations. Existing route authorization, approval, activity, single-assignee, and issue-checkout rules remain authoritative. The model never receives the JWT. A failed or uncertain mutation is surfaced as such; the adapter does not silently retry a non-idempotent request. Task creation requires an idempotency key. Tool output is truncated before returning to the model or run log, and logs avoid raw credentials and full tool arguments.

The adapter only executes within the workspace Paperclip selected for the task. It cannot choose a different directory from a model tool call. The coding pod continues to pin the owner, reviewer, and candidate SHA; this adapter changes only the owner's execution harness. Candidate capture, reviewer sandbox, approval, budget, and recovery gates remain unchanged. Pod configuration rejects the direct local adapter as reviewer. A Splash-owned task requires an explicit reviewer AI Connection binding before pod attachment. Attachment records a redacted snapshot of both selected routes in the task activity log: the local model or the managed AI Connection mode, provider, connection ID, and grant ID. A responsible-user default records its provider and mode because the actual default connection is resolved when the run starts; the run record carries that resolved identity.

## Integration and qualification

Register the adapter in server, UI, CLI, and macOS local setup. The macOS picker shows the LM Studio Splash route without a provider login and reports downloaded-versus-loaded readiness. Agent configuration names the fixed model and endpoint rather than offering a paid-provider selector. V1/V2 bundle identities, ports, and data directories remain unchanged. No database migration or second AI credential system is needed.

Focused tests use a fake LM Studio HTTP server and temporary Git workspaces to prove exact routing, tool call/result cycles, delegated task and comment wakes, file containment, command timeout/cancellation, company-scoped Paperclip API calls, malformed responses, endpoint failure, step limits, and no paid fallback. Live qualification requires the operator to load the Splash model in LM Studio and authorize a disposable Paperclip agent run; no live agent or provider account is used while implementing this adapter.

## Operator live qualification

1. Check free disk and LM Studio's Splash preparation location before loading. Keep the existing Hugging Face weights; loading and cache preparation may consume additional disk and memory.
2. In LM Studio, explicitly load `qwen3.8-27b-splash` and confirm `/api/v1/models` reports `format: splash` with a nonempty `loaded_instances`. Disable JIT loading or pin the instance for the qualification. Do not rely on `/v1/models` alone.
3. Build V2 and test the new local setup option. Create a disposable local owner and task in V2 only, with a disposable Git workspace. Confirm one read, one edit, one command, and a clear final answer; inspect the run log for tool names and usage without credentials.
4. Delegate a child issue and send a later comment wake. Confirm each new heartbeat starts from Paperclip's task context and does not claim an old provider session. Start a second disposable Splash task while one is active: it should show a queue position and make no model request until the first finishes. Stop one waiting run, then stop an active long command and confirm cancellation terminates its process group.
5. Attach a disposable coding pod with the Splash owner and a separately configured sandbox reviewer. Confirm the attachment activity lists the selected routes, reviewer sandbox and board approval stay required, and the V1 app, port, and data directory remain untouched.

Steps 3–5 require explicit authorization to run Paperclip agents. No work or personal Claude/OpenAI account is needed for the local owner; any reviewer using a paid provider must have its intended named AI Connection selected first.
