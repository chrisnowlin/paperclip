# App-owned Splash Implementation Plan

**Goal:** Bundle Splash 1.0.2 in V2 and let Paperclip explicitly start/stop the local Qwen Splash server, removing LM Studio/Bionic from inference.

**Base:** `codex/app-owned-splash-v2` branches from the direct-adapter live task at `feb8d01`, itself based on clean V2 commit `0275510`. The internal adapter ID remains for persisted agents.

## Constraints

- Do not touch the main V2 checkout, V1 app, or installed app data.
- Preserve V2 API `3319`, database `54333`, and its data directory. Add only an app-owned loopback Splash port `3321`.
- Bundle executable runtime files and license, not model weights. Use the existing Hugging Face snapshot offline; never redownload or delete weights.
- Start only on a board request. Keep paid-provider authentication and the single Splash-run queue unchanged.
- Check disk before live startup. Do not restart the active V2 app while a run is in progress.

### Task 1: Package and identify Splash

- [x] Test the bundled version and fixed child command.
- [x] Extend `script/build_and_run.sh` to stage Splash 1.0.2 `libexec` and license from the local installation using copy-on-write; make the wrapper pass its bundled path to the V2 server.
- [x] Verify a relocated copy reports version 1.0.2 and imports its Python dependencies; the engine links only macOS system libraries.

### Task 2: App-owned lifecycle

- [x] Test offline startup, exact model/port readiness, busy port, disk gate, duplicate Start, safe Stop, and shutdown cleanup.
- [x] Implement the process controller and board-only start/stop/status routes with activity logging.

### Task 3: Direct adapter route and controls

- [x] Test `/status`, `/v1/models`, legacy model alias, and endpoint failure with no fallback.
- [x] Move the adapter to V2's bundled Splash port; relabel it without changing its persisted type.
- [x] Add Start/Stop actions and readiness feedback to the existing agent UI; run token gates.

### Task 4: Review and live qualification

- [x] Run focused tests, TypeScript/Swift checks, and a relocated-runtime smoke check.
- [x] Inspect free disk and active V2 runs before replacing the app. Run a disposable model task through bundled Splash; verify recovery and explicit Stop/Start.
- [x] Commit and push this work on the isolated branch.
