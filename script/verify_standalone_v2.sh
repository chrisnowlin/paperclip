#!/bin/zsh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
v2="$repo_root/dist/Paperclip Standalone V2.app"
v1="$HOME/Applications/Paperclip Standalone Dev V1.app"
installed="$HOME/Applications/Paperclip Standalone.app"
plist="$v2/Contents/Info.plist"

[[ -d "$v2" ]] || { echo "V2 bundle is missing: $v2" >&2; exit 1; }
[[ -x "$v2/Contents/MacOS/PaperclipStandaloneV2" ]] || { echo "V2 executable is missing" >&2; exit 1; }
[[ -x "$v2/Contents/Resources/bin/node" ]] || { echo "Bundled Node.js is missing" >&2; exit 1; }

check_plist() {
  local key="$1" expected="$2" actual
  actual="$(/usr/libexec/PlistBuddy -c "Print :$key" "$plist")"
  [[ "$actual" == "$expected" ]] || { echo "$key: expected $expected, found $actual" >&2; exit 1; }
}
check_plist CFBundleExecutable PaperclipStandaloneV2
check_plist CFBundleIdentifier ing.paperclip.standalone.cnowlin.v2
check_plist CFBundleName 'Paperclip Standalone V2'
check_plist PaperclipPort 3319
check_plist PaperclipDatabasePort 54333
check_plist PaperclipDataDirectoryName 'Paperclip Standalone V2'

codesign --verify --deep --strict "$v2"
codesign --verify --deep --strict "$v1"
codesign --verify --deep --strict "$installed"

for pair in \
  "$repo_root/cli/dist/index.js:$v2/Contents/Resources/runtime/node_modules/paperclipai/dist/index.js" \
  "$repo_root/server/dist/index.js:$v2/Contents/Resources/runtime/node_modules/@paperclipai/server/dist/index.js" \
  "$repo_root/ui/dist/index.html:$v2/Contents/Resources/runtime/node_modules/@paperclipai/server/ui-dist/index.html"; do
  cmp -s "${pair%%:*}" "${pair#*:}" || { echo "Bundled artifact differs from local source build" >&2; exit 1; }
done
echo 'V2 bundle identity, signature, and local artifacts verified.'

[[ "${1:-}" == '--live' ]] || exit 0

health() { curl -fsS -m 2 "http://127.0.0.1:$1/api/health" >/dev/null; }
health 3317 || { echo 'Installed app must already be running for live isolation check' >&2; exit 1; }
health 3318 || { echo 'V1 dev app must already be running for live isolation check' >&2; exit 1; }
if health 3319; then
  echo 'V2 must be stopped before the live isolation check' >&2
  exit 1
fi
trap 'osascript -e '\''tell application id "ing.paperclip.standalone.cnowlin.v2" to quit'\'' >/dev/null 2>&1 || true' EXIT
open -n "$v2"
ready=false
for _ in {1..45}; do
  if health 3319; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == true ]] || { echo 'V2 health did not become ready' >&2; exit 1; }
osascript -e 'tell application id "ing.paperclip.standalone.cnowlin.v2" to quit'
for _ in {1..15}; do
  health 3319 || break
  sleep 1
done
if health 3319; then echo 'V2 did not stop' >&2; exit 1; fi
health 3318
health 3317
echo 'V2 launch/quit left V1 and installed apps healthy.'
