#!/usr/bin/env bash
# Run the in-app UI self-test (src/lib/selftest.ts) against a built MobyD.app:
# it opens a demo repository in the real window, drives the UI, and writes a
# JSON report. Exits non-zero when any check fails.
#
#   scripts/selftest.sh [path/to/MobyD.app]
#
# The app runs as a renamed copy (bundle id org.mobyd.selftest) with its own
# settings folder, so it never touches the installed app's settings, tabs,
# accounts or web storage. Languages: SELFTEST_LANGS="en ko" (default).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/src-tauri/target/release/bundle/macos/MobyD.app}"
LANGS="${SELFTEST_LANGS:-en ko}"
TIMEOUT="${SELFTEST_TIMEOUT:-180}"
ID="org.mobyd.selftest"
[[ -d "$APP" ]] || { echo "No app at $APP (build it with: pnpm release)" >&2; exit 2; }

WORK="$(mktemp -d)"
cleanup() {
  [[ -n "${PID:-}" ]] && kill "$PID" 2>/dev/null || true
  rm -rf "$WORK" "$HOME/Library/WebKit/$ID" "$HOME/Library/Caches/$ID" "$HOME/Library/Saved Application State/$ID.savedState"
}
trap cleanup EXIT

cp -R "$APP" "$WORK/MobyD.app"
plutil -replace CFBundleIdentifier -string "$ID" "$WORK/MobyD.app/Contents/Info.plist"
codesign --force --deep --sign - "$WORK/MobyD.app" 2>/dev/null
BIN="$WORK/MobyD.app/Contents/MacOS/$(plutil -extract CFBundleExecutable raw "$WORK/MobyD.app/Contents/Info.plist")"

status=0
for lang in $LANGS; do
  out="$WORK/report-$lang.json"
  mkdir -p "$WORK/config-$lang"
  # Each run commits and undoes in its repository, so every language gets a fresh one.
  "$ROOT/scripts/make-demo-repo.sh" "$WORK/pod-$lang" >/dev/null
  MOBYD_SELFTEST_OUT="$out" MOBYD_SELFTEST_CONFIG="$WORK/config-$lang" \
    MOBYD_SELFTEST_REPO="$WORK/pod-$lang" MOBYD_SELFTEST_LANG="$lang" \
    "$BIN" -ApplePersistenceIgnoreState YES >"$WORK/app-$lang.log" 2>&1 &
  PID=$!
  for ((i = 0; i < TIMEOUT * 2; i++)); do
    [[ -s "$out" ]] && break
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.5
  done
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  PID=""
  if [[ ! -s "$out" ]]; then
    echo "[$lang] no report after ${TIMEOUT}s; app log:" >&2
    tail -40 "$WORK/app-$lang.log" >&2 || true
    status=1
    continue
  fi
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const c of r.checks) console.log(`[${process.argv[2]}] ${c.ok ? "PASS" : "FAIL"} ${c.name} (${c.ms} ms)${c.ok ? "" : " — " + c.detail}`);
    if (!r.ok || r.checks.length === 0) process.exit(1);
  ' "$out" "$lang" || status=1
done
exit $status
