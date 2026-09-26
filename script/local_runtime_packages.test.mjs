import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveRuntimePackages, rewriteStagedWorkspaceVersions } from "./local_runtime_packages.mjs";

test("orders local runtime packages after their workspace dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-runtime-packages-"));
  try {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts/release-package-manifest.json"), JSON.stringify([
      { dir: "server", name: "@paperclipai/server" },
      { dir: "shared", name: "@paperclipai/shared" },
      { dir: "adapter", name: "@paperclipai/adapter" },
      { dir: "unrelated", name: "@paperclipai/unrelated" },
    ]));
    for (const [dir, dependencies] of [
      ["server", { "@paperclipai/adapter": "workspace:*" }],
      ["adapter", { "@paperclipai/shared": "workspace:*" }],
      ["shared", {}],
      ["unrelated", {}],
    ]) {
      mkdirSync(join(root, dir));
      writeFileSync(join(root, dir, "package.json"), JSON.stringify({ dependencies }));
    }
    assert.deepEqual(resolveRuntimePackages(root).map(({ name }) => name), [
      "@paperclipai/shared", "@paperclipai/adapter", "@paperclipai/server",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an unstaged workspace dependency", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-runtime-packages-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "server"));
    writeFileSync(join(root, "scripts/release-package-manifest.json"), JSON.stringify([
      { dir: "server", name: "@paperclipai/server" },
    ]));
    writeFileSync(join(root, "server/package.json"), JSON.stringify({
      dependencies: { "@paperclipai/missing": "workspace:*" },
    }));
    assert.throws(() => resolveRuntimePackages(root), /missing from.*release-package-manifest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses each workspace package's actual version in a staged manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-runtime-packages-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "server"));
    mkdirSync(join(root, "sdk"));
    mkdirSync(join(root, "staged"));
    writeFileSync(join(root, "scripts/release-package-manifest.json"), JSON.stringify([
      { dir: "server", name: "@paperclipai/server" },
      { dir: "sdk", name: "@paperclipai/plugin-sdk" },
    ]));
    writeFileSync(join(root, "server/package.json"), JSON.stringify({ version: "0.3.1" }));
    writeFileSync(join(root, "sdk/package.json"), JSON.stringify({ version: "1.0.0" }));
    const stagedPath = join(root, "staged/package.json");
    writeFileSync(stagedPath, JSON.stringify({
      dependencies: { "@paperclipai/plugin-sdk": "0.3.1", "express": "^5.1.0" },
    }));
    rewriteStagedWorkspaceVersions(root, stagedPath);
    assert.deepEqual(JSON.parse(readFileSync(stagedPath, "utf8")).dependencies, {
      "@paperclipai/plugin-sdk": "1.0.0", express: "^5.1.0",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
