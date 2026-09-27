#!/bin/zsh
set -euo pipefail
setopt null_glob

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
app_project="$repo_root/macos/PaperclipStandaloneDev"
runtime_dir="$app_project/runtime"
app_bundle="$repo_root/dist/Paperclip Standalone V2.app"

if pgrep -x PaperclipStandaloneV2 >/dev/null 2>&1; then
  echo "A V2 app is running. Stop it cleanly before replacing its bundle." >&2
  exit 1
fi

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

# Validate the bundle source before running the expensive build or replacing
# the previous app. Model weights are never copied into the bundle.
splash_prefix="$(brew --prefix splash)"
splash_libexec="$(cd "$splash_prefix/libexec" && pwd -P)"
"$node_src" -e 'const r=require(process.argv[1]);if(r.version!=="1.0.2")process.exit(1)' \
  "$splash_libexec/release.json" || {
  echo "Splash 1.0.2 must be installed locally before bundling V2." >&2
  exit 1
}
[[ -x "$splash_libexec/python/bin/python3" && -x "$splash_libexec/engine/splash" && -f "$splash_prefix/LICENSE" ]] || {
  echo "The installed Splash runtime is incomplete." >&2
  exit 1
}

"$repo_root/script/build_local_runtime.sh" "$node_src"

swift build -c release --package-path "$app_project"
rm -rf "$app_bundle"
mkdir -p "$app_bundle/Contents/MacOS" "$app_bundle/Contents/Resources/bin" \
  "$app_bundle/Contents/Resources/runtime"
cp "$app_project/.build/release/PaperclipStandaloneV2" "$app_bundle/Contents/MacOS/PaperclipStandaloneV2"
cp "$node_src" "$app_bundle/Contents/Resources/bin/node"
cp -cR "$runtime_dir/node_modules" "$app_bundle/Contents/Resources/runtime/"

# Splash is app-owned at runtime. Bundle its installed 1.0.2 program files,
# never its model weights or Hugging Face cache.
splash_bundle="$app_bundle/Contents/Resources/splash"
mkdir -p "$splash_bundle"
cp -cR "$splash_libexec/." "$splash_bundle/"
cp "$splash_prefix/LICENSE" "$splash_bundle/LICENSE"
[[ -x "$splash_bundle/python/bin/python3" && -x "$splash_bundle/engine/splash" ]] || {
  echo "The bundled Splash runtime is incomplete." >&2
  exit 1
}

cat > "$app_bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>PaperclipStandaloneV2</string>
  <key>CFBundleIdentifier</key><string>ing.paperclip.standalone.cnowlin.v2</string>
  <key>CFBundleName</key><string>Paperclip Standalone V2</string>
  <key>CFBundleDisplayName</key><string>Paperclip Standalone V2</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2026.916.1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSMultipleInstancesProhibited</key><true/>
  <key>PaperclipPort</key><integer>3319</integer>
  <key>PaperclipDatabasePort</key><integer>54333</integer>
  <key>PaperclipSplashPort</key><integer>3321</integer>
  <key>PaperclipDataDirectoryName</key><string>Paperclip Standalone V2</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST

codesign --force --deep --sign - "$app_bundle" >/dev/null
echo "Built $app_bundle"
if [[ "${1:-}" != "--build-only" ]]; then
  open "$app_bundle"
fi
