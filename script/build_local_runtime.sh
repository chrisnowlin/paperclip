#!/bin/zsh
set -euo pipefail
setopt null_glob

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
runtime_dir="$repo_root/macos/PaperclipStandaloneDev/runtime"
node_src="${1:?Pass the Node.js 24 executable path}"
node_bin_dir="${node_src:h}"
export PATH="$node_bin_dir:$PATH"

mkdir -p "$runtime_dir"
stage_dir="$(mktemp -d "$runtime_dir/.local-build.XXXXXX")"
cp "$repo_root/cli/package.json" "$stage_dir/cli-package.json"
[[ ! -f "$repo_root/cli/package.dev.json" ]] || cp "$repo_root/cli/package.dev.json" "$stage_dir/cli-package.dev.json"
[[ ! -f "$repo_root/cli/README.md" ]] || cp "$repo_root/cli/README.md" "$stage_dir/cli-README.md"
created_skills=()
created_ui_dist=false
[[ -e "$repo_root/server/ui-dist" ]] || created_ui_dist=true
cleanup() {
  cp "$stage_dir/cli-package.json" "$repo_root/cli/package.json"
  if [[ -f "$stage_dir/cli-package.dev.json" ]]; then
    cp "$stage_dir/cli-package.dev.json" "$repo_root/cli/package.dev.json"
  else
    rm -f "$repo_root/cli/package.dev.json"
  fi
  if [[ -f "$stage_dir/cli-README.md" ]]; then
    cp "$stage_dir/cli-README.md" "$repo_root/cli/README.md"
  else
    rm -f "$repo_root/cli/README.md"
  fi
  for target in "${created_skills[@]}"; do rm -rf "$target"; done
  if [[ "$created_ui_dist" == true ]]; then rm -rf "$repo_root/server/ui-dist"; fi
  rm -rf "$stage_dir"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

cd "$repo_root"
"$node_bin_dir/corepack" pnpm install --frozen-lockfile
"$node_bin_dir/corepack" pnpm -r --filter '@paperclipai/server...' --if-present run build
bash "$repo_root/scripts/prepare-server-ui-dist.sh"
for package_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
  target="$repo_root/$package_dir/skills"
  if [[ ! -e "$target" ]]; then
    cp -R "$repo_root/skills" "$target"
    created_skills+=("$target")
  fi
done
bash "$repo_root/scripts/build-npm.sh" --skip-checks --skip-typecheck

while IFS=$'\t' read -r package_dir package_name; do
  package_root="$repo_root/$package_dir"
  bundled_count="$("$node_src" -p 'const p=require(process.argv[1]);(p.bundleDependencies||p.bundledDependencies||[]).length' "$package_root/package.json")"
  if [[ "$bundled_count" -gt 0 ]]; then
    bundled_dir="$stage_dir/bundled-${package_name//\//-}"
    "$node_src" "$repo_root/scripts/prepare-bundled-package.mjs" "$package_root" "$bundled_dir"
    "$node_src" "$repo_root/script/local_runtime_packages.mjs" rewrite-manifest \
      "$repo_root" "$bundled_dir/package.json"
    "$node_bin_dir/npx" --yes npm@10.9.7 pack "$bundled_dir" \
      --pack-destination "$stage_dir" --ignore-scripts --silent >/dev/null
  else
    PAPERCLIP_RELEASE_REUSE_UI_DIST=1 "$node_bin_dir/corepack" pnpm --dir "$package_root" pack --pack-destination "$stage_dir" >/dev/null
  fi
done < <("$node_src" "$repo_root/script/local_runtime_packages.mjs" "$repo_root")
"$node_bin_dir/npm" pack "$repo_root/cli" --pack-destination "$stage_dir" --ignore-scripts --silent >/dev/null

tarballs=("$stage_dir"/*.tgz)
[[ ${#tarballs} -gt 1 ]] || { echo "Local Paperclip package set is incomplete." >&2; exit 1; }
"$node_bin_dir/npm" install --prefix "$runtime_dir" --registry https://registry.npmjs.org \
  --no-audit --no-fund --omit=dev "${tarballs[@]}"
embedded_pg="$runtime_dir/node_modules/@embedded-postgres/darwin-arm64"
if [[ -f "$embedded_pg/scripts/hydrate-symlinks.js" ]]; then
  (cd "$embedded_pg" && "$node_src" scripts/hydrate-symlinks.js)
fi
"$node_src" "$runtime_dir/node_modules/paperclipai/dist/index.js" --version >/dev/null
for pair in \
  "$repo_root/cli/dist/index.js:$runtime_dir/node_modules/paperclipai/dist/index.js" \
  "$repo_root/server/dist/index.js:$runtime_dir/node_modules/@paperclipai/server/dist/index.js" \
  "$repo_root/ui/dist/index.html:$runtime_dir/node_modules/@paperclipai/server/ui-dist/index.html"; do
  source_file="${pair%%:*}"
  packaged_file="${pair#*:}"
  cmp -s "$source_file" "$packaged_file" || {
    echo "Local Paperclip artifact does not match packaged runtime: $packaged_file" >&2
    exit 1
  }
done
echo "Built local Paperclip runtime from this checkout."
