import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveRuntimePackages(repoRoot) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "scripts/release-package-manifest.json"), "utf8"));
  const byName = new Map(manifest.map((entry) => [entry.name, entry]));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];

  function visit(name) {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Circular workspace dependency while staging ${name}.`);
    const entry = byName.get(name);
    if (!entry) throw new Error(`Workspace dependency ${name} is missing from scripts/release-package-manifest.json.`);
    visiting.add(name);
    const pkg = JSON.parse(readFileSync(join(repoRoot, entry.dir, "package.json"), "utf8"));
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dependency of Object.keys(pkg[section] ?? {})) {
        if (dependency.startsWith("@paperclipai/")) visit(dependency);
      }
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(entry);
  }

  visit("@paperclipai/server");
  return ordered;
}

export function rewriteStagedWorkspaceVersions(repoRoot, stagedManifestPath) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "scripts/release-package-manifest.json"), "utf8"));
  const versions = new Map(manifest.map(({ dir, name }) => [
    name, JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8")).version,
  ]));
  const staged = JSON.parse(readFileSync(stagedManifestPath, "utf8"));
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const name of Object.keys(staged[section] ?? {})) {
      if (versions.has(name)) staged[section][name] = versions.get(name);
    }
  }
  writeFileSync(stagedManifestPath, `${JSON.stringify(staged, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "rewrite-manifest") {
    rewriteStagedWorkspaceVersions(process.argv[3], process.argv[4]);
  } else {
    for (const { dir, name } of resolveRuntimePackages(process.argv[2])) {
      process.stdout.write(`${dir}\t${name}\n`);
    }
  }
}
