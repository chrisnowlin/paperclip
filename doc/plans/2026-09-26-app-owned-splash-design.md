# App-owned Splash runtime for Standalone V2

Status: implementation design · 2026-09-26

## Decision

V2 bundles the installed Splash 1.0.2 program files, including its Python and native engine, but not the 16 GiB model weights. Paperclip starts and stops the bundled Splash server as a child of its own server process. The existing Hugging Face snapshot supplies `incoai/Qwen3.8-27B-Splash` offline. Bionic/LM Studio is no longer an inference dependency. No model download or provider-account fallback is permitted.

Keep the persisted adapter type `lmstudio_splash_local` so the already-created CTO, Coder, and Splash Local agents remain usable. Rename its user-facing label to **Splash (app-managed)**. The fixed API route moves to `127.0.0.1:3321`; the launch adds the legacy `qwen3.8-27b-splash` alias while `/status` must identify the canonical `incoai` package. This port is private to V2 and does not change V1/V2 app, API, database, or data-directory identities.

## Lifecycle and authority

An instance-admin board action starts Splash; another action stops it. Task assignment never starts a model silently. Starting checks at least 8 GiB of disk headroom, the existing local snapshot, the bundled executable, port ownership, and that no other local LLM is loaded. It sets Hugging Face offline mode and launches the fixed model with a 28 GiB Metal ceiling, bounded context, no web UI, and a fixed loopback bind. Readiness verifies `/ready`, `/status.instance.model`, and the Splash-owned model alias. Repeated starts coalesce and never create a second instance. Stopping refuses while a Paperclip Splash run is active; orderly V2 shutdown stops its child after runs drain. If the child exits unexpectedly, a new explicit Start request can recover it.

The bundle uses V2-owned writable runtime/model-link state and the existing Hugging Face cache. It links the cached revision into its private home and seeds Splash's model catalog locally before launch, so the launcher does not query the Hub or duplicate weights. Splash's compiled weight cache may be relocated through `SPLASH_WEIGHT_CACHE`; no cache directory is deleted or silently moved. The model snapshot remains external to the app bundle. Paperclip checks free disk before launch and returns an actionable failure when storage is too low.

When `SPLASH_WEIGHT_CACHE` names an existing absolute directory, the 8 GiB check applies to that volume. V2 still needs 0.5 GiB free for its private metadata. Without that setting, both checks apply to V2's data volume. The setting must be present in V2's environment before launch.

The existing Paperclip-owned five-tool coding loop and single-run queue remain intact. Its model requests and environment tests now address only the app-owned Splash server. Claude, OpenAI, and OpenCode account bindings are unchanged. The local adapter never receives their credentials.

## Qualification

Focused tests cover relocated runtime imports, offline launch arguments, model/port identity, startup failure, concurrent Start calls, Stop while busy, no download, and unchanged paid-provider routing. A live check requires at least 8 GiB free disk and no other loaded local LLM, then a disposable task through the V2 app. The currently running V2 process must not be restarted while another agent run is active.

Live qualification with the operator: free enough disk without removing the cached weights, finish active V2 runs, close or unload Bionic's model, rebuild and relaunch V2, press **Start Splash**, verify exact model readiness, delegate a disposable task to a Splash agent, inspect its tool and activity ledger, then press **Stop Splash** after the run finishes. The older LM Studio-backed E2E task does not qualify the app-owned runtime.

## Local staging evidence

An updated V2 bundle was staged from the checked-out compiled server, adapter, UI, and Swift files, with a copy-on-write Splash 1.0.2 runtime and its license. The packaged runner vendor was preserved from the prior bundle. The signature verified, the bundled server module imported, and V2 restarted healthy on `3319` with its original data. `GET` runtime status returned `stopped` for the exact model on `3321`. `POST` Start returned HTTP 409 `splash_disk_low` with 2.3 GiB free; no Splash process listened on `3321`. The prior bundle remains as a rollback copy. This is a packaging smoke check, not a model inference qualification or a full `build_and_run.sh` build.

## Live qualification after disk recovery

With about 50 GiB free and no other local-model listener, V2 started its bundled Splash child. `/ready`, `/status`, and `/v1/models` identified the exact `incoai/Qwen3.8-27B-Splash` package, child PID, loopback port `3321`, and `qwen3.8-27b-splash` alias. Assigning disposable issue `SPLA-1` to the existing `Splash Local` agent started run `6ae4d085-e8dd-4fab-801e-d4ffe9003805` without a manual wake. The run succeeded in about 26 seconds and set the issue to `done`. Its log records `list_files`, `read_file`, `write_file`, `run_command`, and `paperclip_request` tool calls. It created the requested one-line `RESULT.txt`, checked Git status, and posted the verification comment. One command call returned an error; the agent retried and completed successfully. No provider account or alternate inference endpoint was used.

After the task, V2 received a graceful `SIGTERM` from an unidentified source. Its run drain completed, and both the app and Splash process exited. Reopening V2 showed Splash `stopped`; an explicit Start restored `ready`. An explicit Stop removed the `3321` listener and native engine process, and another Start restored `ready`. The model remains loaded for subsequent test tasks. The full release packaging script has not been run; this qualification used the signed staged bundle described above.

The full workspace `pnpm -r typecheck` passed after disk recovery. The changed adapter's 72 tests, Splash runtime and route tests, UI registry tests, Swift test, token gates, and server/UI compilation passed. The broad `pnpm test:run` suite was stopped during unrelated chat/workspace integration tests after the focused checks and live task had passed; no suite result is claimed. `pnpm build` and the complete `build_and_run.sh` packaging pipeline remain unverified.
