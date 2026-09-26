# Paperclip Standalone V2 development project

This is a local checkout of [paperclipai/paperclip](https://github.com/paperclipai/paperclip) at tag `v2026.916.1` (`d554c478`). [chrisnowlin/paperclip](https://github.com/chrisnowlin/paperclip) is its GitHub fork and the `origin` remote; the original repository remains the `upstream` remote. V1 is preserved on branch `standalone-v1`, tag `standalone-v1-verified-2026-09-26`, and in `~/Applications/Paperclip Standalone Dev V1.app`. This branch develops the independent V2 app.

## What is here

- The upstream Paperclip source is at the repository root (`server/`, `ui/`, `packages/`, `cli/`).
- `macos/PaperclipStandaloneDev/` contains the SwiftPM macOS wrapper developed for the installed standalone app. It includes the menu bar controls, local agent setup, and the in-app OpenCode option in the new-organization wizard.
- `script/build_and_run.sh` builds `dist/Paperclip Standalone V2.app` and launches it. Each build uses `script/build_local_runtime.sh` to build and package the Paperclip CLI, server, UI, and required workspace packages from this checkout into the Git-ignored wrapper `runtime/` directory, then bundles Node.js 24.

**V2** uses `http://127.0.0.1:3319`, embedded PostgreSQL port `54333`, and `~/Library/Application Support/Paperclip Standalone V2`. The V1 dev app uses port `3318`; the installed **Paperclip Standalone** app uses port `3317`. Their processes, bundles, and databases are separate.

## Build

Prerequisites: macOS 14+, Xcode command-line tools, and Node.js 24.11+ with npm and Corepack. The first full bundle build installs the workspace's pnpm dependencies, creates local npm packages, installs their production dependencies, and copies the runtime into the app. Leave several GB of free space for these outputs.

```sh
./script/build_and_run.sh --build-only  # package without launching
./script/build_and_run.sh               # stop, build, and launch the dev app
```

The wrapper alone can be compiled without downloading the Paperclip runtime:

```sh
swift build -c release --package-path macos/PaperclipStandaloneDev
```

The Codex project Run action calls `./script/build_and_run.sh`.

## Editing Paperclip source

V2 packages local source. Edits to `ui/`, `server/`, and their workspace dependencies are included on the next `./script/build_and_run.sh` build. The build packages the CLI and server separately because the CLI loads `@paperclipai/server` at runtime. It restores the CLI's development manifest after packaging. Neither V1 app is updated by this script.

## GitHub remotes and branches

Push project branches to `origin`; fetch Paperclip releases from `upstream`. `standalone-v1` preserves the working source baseline, and `codex/governed-cockpit-v2` contains V2 work. The clone is shallow at the release tag; fetch more history if you need to rebase or compare older commits.

Do not commit `macos/PaperclipStandaloneDev/runtime/`, `dist/`, instance data, or credentials. The first two are Git-ignored here; instance data lives outside this repository.
