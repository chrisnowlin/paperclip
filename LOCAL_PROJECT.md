# Paperclip Standalone V2 development project

This is a local checkout of [paperclipai/paperclip](https://github.com/paperclipai/paperclip) at tag `v2026.916.1` (`d554c478`). [chrisnowlin/paperclip](https://github.com/chrisnowlin/paperclip) is its GitHub fork and the `origin` remote; the original repository remains the `upstream` remote. V1 is preserved on branch `standalone-v1`, tag `standalone-v1-verified-2026-09-26`, and in `~/Applications/Paperclip Standalone Dev V1.app`. This branch develops the independent V2 app.

## What is here

- The upstream Paperclip source is at the repository root (`server/`, `ui/`, `packages/`, `cli/`).
- `macos/PaperclipStandaloneDev/` contains the SwiftPM macOS wrapper developed for the installed standalone app. It includes the menu bar controls, local agent setup, and the in-app OpenCode option in the new-organization wizard.
- The local agent setup also offers **Splash (app-managed)**. V2 bundles Splash 1.0.2 program files and starts its own `incoai/Qwen3.8-27B-Splash` server at `127.0.0.1:3321` on a local task wake or when an instance admin presses **Start Splash** in agent settings. The existing Hugging Face model snapshot remains outside the app. The Paperclip-owned coding loop does not use OpenCode, LM Studio, or a Claude/OpenAI login.
- `script/build_and_run.sh` builds `dist/Paperclip Standalone V2.app` and launches it. Each build uses `script/build_local_runtime.sh` to build and package the Paperclip CLI, server, UI, and required workspace packages from this checkout into the Git-ignored wrapper `runtime/` directory, then bundles Node.js 24.

**V2** uses `http://127.0.0.1:3319`, embedded PostgreSQL port `54333`, and `~/Library/Application Support/Paperclip Standalone V2`. The V1 dev app uses port `3318`; the installed **Paperclip Standalone** app uses port `3317`. Their processes, bundles, and databases are separate.

## Build

Prerequisites: macOS 14+, Xcode command-line tools, and Node.js 24.11+ with npm and Corepack. The first full bundle build installs the workspace's pnpm dependencies, creates local npm packages, installs their production dependencies, and copies the runtime into the app. Leave several GB of free space for these outputs.

```sh
./script/build_and_run.sh --build-only  # package without launching
./script/build_and_run.sh --stage-only  # sign a separate .staged.app while V2 runs; do not launch or replace it
./script/build_and_run.sh               # build and launch the dev app when V2 is stopped
```

The stage-only bundle is `dist/Paperclip Standalone V2.staged.app`. It has the same identity and ports as V2, so never launch it alongside the live app. After active runs finish, stop V2 cleanly and install the staged bundle before relaunching.

The wrapper alone can be compiled without downloading the Paperclip runtime:

```sh
swift build -c release --package-path macos/PaperclipStandaloneDev
```

The Codex project Run action calls `./script/build_and_run.sh`.

## Editing Paperclip source

V2 packages local source. Edits to `ui/`, `server/`, and their workspace dependencies are included on the next `./script/build_and_run.sh` build. The build packages the CLI and server separately because the CLI loads `@paperclipai/server` at runtime. It restores the CLI's development manifest after packaging. Neither V1 app is updated by this script.

## Governed coding cockpit

In V2, open a project's **Configuration** tab to choose an active owner agent and a different active reviewer agent. The project needs a local Git-backed primary workspace and isolated workspaces enabled in instance settings. The reviewer must have an active sandbox environment selected as its default; configure a sandbox provider and that agent's environment before saving. Saving the pod only records configuration.

The Splash agent can be the local-trusted owner. It has Paperclip-owned file, command, and company-scoped task tools; commands run with the current macOS user's authority. It cannot be the sandbox reviewer. A Splash-owned task requires the reviewer to have an explicit AI Connection binding before attachment; choose the intended named account on that reviewer agent first. Attachment records the selected local route and reviewer connection IDs in the task activity log. A responsible-user default is resolved for each run and is not a fixed account at attachment time.

A Splash CTO with Paperclip's agent-create permission can use the `hire_coder` tool for up to three hires per run. The tool creates only an app-managed Splash coder or an OpenCode coder pinned to `zai-coding-plan/glm-5.3-flash`; it records the route and hiring run in agent metadata. The GLM choice uses the installed OpenCode Z.ai login, which is separate from managed Claude/OpenAI AI Connections. It never rotates accounts or falls back to a different model. New coders should receive project-bound tasks with an explicit project workspace, and the CTO should record each task-to-agent route decision on the task.

Only one Splash agent run executes at a time in the V2 server. Three more may wait FIFO for up to two hours; a full queue fails visibly, and Stop removes a waiter. The slot covers the entire coding/tool run, bounded to two hours, while each model turn gets a separate 25-minute limit. Stop Splash refuses while work is active, and Start Splash refuses when another local LLM is loaded or port `3321` is occupied.

The bundled Qwen model has a native 262,144-token context. V2 requests 85% of that limit (222,822 tokens) and caps output at the same value. Before each Chat turn, the adapter asks Splash to render and tokenize the prompt, then reduces the requested output to the remaining context. A length-limited answer is never treated as a completed tool call or final answer.

During a long local turn, the live run status refreshes every 15 seconds with prompt tokens, that turn's output allowance, and an approximate count of output tokens generated so far. The count is a delta from Splash's model-wide decode counter, so another loopback client could affect it; it does not predict how much of the model's output will be visible after reasoning ends.

A run waiting for the single local model slot refreshes its wait status every 30 seconds and shows **Waiting for local model** in the execution badge. Once Splash is prefilling or generating, the badge shows **Working** even before the first durable run-log line. These are ephemeral status signals; they do not change task ownership or run state.

Splash Chat turns stream locally so the live status can show a short rolling reasoning excerpt. That excerpt is redacted and kept only in the ephemeral live-status channel, not written to the run log. Paperclip assembles and validates the entire streamed answer before executing any tool call. A timeout or incomplete stream discards partial tool calls and in-flight model text; already completed workspace/task tool actions remain recorded.

For broad local assignments, the Splash CTO coordinates first: inspect existing child issues, name at most three narrow child tasks with one deliverable and acceptance check each, assign them to explicit local Splash agents, and comment the routing decision on the parent. A Coder run handles one scoped deliverable at a time. Remote or paid-provider assignment requires an explicit board decision and named AI Connection. Browser QA and artifact publication can be separate follow-up steps; the current local tool set does not itself upload issue attachments.

On a parked backlog task in that project, choose **Attach coding pod**. Attachment pins the owner, reviewer, and board approver to that task and leaves it parked. Start the owner through the normal Paperclip workflow when ready. A clean committed owner worktree becomes an exact Git candidate before reviewer dispatch. The reviewer uses a separate worktree pinned to that commit and a restricted read/test policy. The task cockpit links the candidate comparison through GitHub when available or a bounded local diff otherwise, plus the workspaces, plan, work products, run ledger, and stage comments. Board approval requires a written decision and the candidate must still match the source worktree. If it moved or became dirty, return the task to the owner for a new clean candidate.

V2's initial project and task data are separate from the V1 app. Do not launch live agents during build or smoke verification; a live coding-pod qualification needs a separate explicit request.

See [the app-owned Splash design](doc/plans/2026-09-26-app-owned-splash-design.md) for the readiness contract and live qualification steps. Starting requires at least 8 GiB free on the prepared-weight cache volume and 0.5 GiB for V2 metadata. Set `SPLASH_WEIGHT_CACHE` to an existing absolute directory before launching V2 to use another volume. No model weights are bundled or downloaded. The standalone Splash server on port `8000` is not used by this route.

## GitHub remotes and branches

Push project branches to `origin`; fetch Paperclip releases from `upstream`. `standalone-v1` preserves the working source baseline, and `codex/governed-cockpit-v2` contains V2 work. The clone is shallow at the release tag; fetch more history if you need to rebase or compare older commits.

Do not commit `macos/PaperclipStandaloneDev/runtime/`, `dist/`, instance data, or credentials. The first two are Git-ignored here; instance data lives outside this repository.
