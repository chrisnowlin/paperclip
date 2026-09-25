#!/bin/zsh
set -euo pipefail
setopt null_glob

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
app_project="$repo_root/macos/PaperclipStandaloneDev"
runtime_dir="$app_project/runtime"
app_bundle="$repo_root/dist/Paperclip Standalone Dev.app"

node_src=""
for candidate in "$HOME"/.nvm/versions/node/v24.*/bin/node /opt/homebrew/opt/node@24/bin/node /opt/homebrew/bin/node; do
  [[ -x "$candidate" ]] || continue
  if "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||a===24&&b>=11?0:1)' >/dev/null 2>&1; then
    node_src="$candidate"
    break
  fi
done
if [[ -z "$node_src" ]]; then
  echo "Node.js 24.11+ is required. Install it before building." >&2
  exit 1
fi
node_bin_dir="${node_src:h}"

if [[ ! -f "$runtime_dir/node_modules/paperclipai/dist/index.js" ]]; then
  mkdir -p "$runtime_dir"
  PATH="$node_bin_dir:$PATH" "$node_bin_dir/npm" install \
    --prefix "$runtime_dir" --registry https://registry.npmjs.org \
    --no-audit --no-fund --omit=dev paperclipai@2026.916.1
  embedded_pg="$runtime_dir/node_modules/@embedded-postgres/darwin-arm64"
  if [[ -f "$embedded_pg/scripts/hydrate-symlinks.js" ]]; then
    (cd "$embedded_pg" && "$node_src" scripts/hydrate-symlinks.js)
  fi
fi

for app_pid in $(pgrep -x PaperclipStandaloneDev 2>/dev/null || true); do
  for child_pid in $(pgrep -P "$app_pid" 2>/dev/null || true); do
    kill -TERM "$child_pid" 2>/dev/null || true
  done
  kill -TERM "$app_pid" 2>/dev/null || true
done

swift build -c release --package-path "$app_project"
rm -rf "$app_bundle"
mkdir -p "$app_bundle/Contents/MacOS" "$app_bundle/Contents/Resources/bin" \
  "$app_bundle/Contents/Resources/runtime"
cp "$app_project/.build/release/PaperclipStandaloneDev" "$app_bundle/Contents/MacOS/PaperclipStandaloneDev"
cp "$node_src" "$app_bundle/Contents/Resources/bin/node"
ditto "$runtime_dir/node_modules" "$app_bundle/Contents/Resources/runtime/node_modules"

cat > "$app_bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>PaperclipStandaloneDev</string>
  <key>CFBundleIdentifier</key><string>ing.paperclip.standalone.cnowlin.dev</string>
  <key>CFBundleName</key><string>Paperclip Standalone Dev</string>
  <key>CFBundleDisplayName</key><string>Paperclip Standalone Dev</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2026.916.1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSMultipleInstancesProhibited</key><true/>
  <key>PaperclipPort</key><integer>3318</integer>
  <key>PaperclipDatabasePort</key><integer>54332</integer>
  <key>PaperclipDataDirectoryName</key><string>Paperclip Standalone Dev</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST

codesign --force --deep --sign - "$app_bundle" >/dev/null
echo "Built $app_bundle"
if [[ "${1:-}" != "--build-only" ]]; then
  open "$app_bundle"
fi
