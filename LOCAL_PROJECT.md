# Paperclip Standalone development project

This is a local checkout of [paperclipai/paperclip](https://github.com/paperclipai/paperclip) at tag `v2026.916.1` (`d554c478`). It is on the local branch `standalone-macos`. The original repository is configured as the `upstream` remote. No personal GitHub fork or `origin` remote has been created.

## What is here

- The upstream Paperclip source is at the repository root (`server/`, `ui/`, `packages/`, `cli/`).
- `macos/PaperclipStandaloneDev/` contains the SwiftPM macOS wrapper developed for the installed standalone app. It includes the menu bar controls, local agent setup, and the in-app OpenCode option in the new-organization wizard.
- `script/build_and_run.sh` builds the development app at `dist/Paperclip Standalone Dev.app` and launches it. On first use, it installs the pinned Paperclip npm runtime into the Git-ignored wrapper `runtime/` directory and bundles Node.js 24.

The **development app** uses `http://127.0.0.1:3318`, embedded PostgreSQL port `54332`, and `~/Library/Application Support/Paperclip Standalone Dev`. The installed **Paperclip Standalone** app uses port `3317` and its own data directory. Their processes, bundles, and databases are separate.

## Build

Prerequisites: macOS 14+, Xcode command-line tools, and Node.js 24.11+ with npm. The first full bundle build downloads the pinned npm runtime and needs roughly 3 GB of free space for its runtime and bundle.

```sh
./script/build_and_run.sh --build-only  # package without launching
./script/build_and_run.sh               # stop, build, and launch the dev app
```

The wrapper alone can be compiled without downloading the Paperclip runtime:

```sh
swift build -c release --package-path macos/PaperclipStandaloneDev
```

The Codex project Run action calls `./script/build_and_run.sh`.

## Continuing toward a fork

The current wrapper packages the published `paperclipai@2026.916.1` runtime. **Edits to the upstream `ui/` or `server/` source in this checkout will not appear in the app bundle yet.** When you begin customizing Paperclip itself, wire the wrapper's packaging script to a local source build (`pnpm install`, `pnpm build:npm`) before testing those changes in the macOS app. Keep that change separate from the working installed app until verified.

When you decide to fork on GitHub, create your fork there, add it as this checkout's `origin`, and push `standalone-macos`. Keep `upstream` pointed at `paperclipai/paperclip` so you can fetch later releases. The clone is shallow at the release tag; fetch more history if you need to rebase or compare older commits.

Do not commit `macos/PaperclipStandaloneDev/runtime/`, `dist/`, instance data, or credentials. The first two are Git-ignored here; instance data lives outside this repository.
