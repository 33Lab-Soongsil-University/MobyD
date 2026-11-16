#!/usr/bin/env bash
# Release build that keeps local paths (home directory, checkout location)
# out of the shipped binary, then wraps the .app in a compressed DMG.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=~ --remap-path-prefix=$ROOT=."
# With the updater signing key in the environment (CI), also produce the
# signed update archive (MobyD.app.tar.gz + .sig) that running apps download.
EXTRA=()
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  EXTRA=(--config '{"bundle":{"createUpdaterArtifacts":true}}')
fi
pnpm tauri build --bundles app ${EXTRA[@]+"${EXTRA[@]}"} "$@"
APP="src-tauri/target/release/bundle/macos/MobyD.app"
if [[ "$(uname)" == "Darwin" && -d "$APP" ]]; then
  VERSION="$(node -p "require('./package.json').version")"
  ARCH="$(uname -m)"
  mkdir -p src-tauri/target/release/bundle/dmg
  DMG="src-tauri/target/release/bundle/dmg/MobyD_${VERSION}_${ARCH}.dmg"
  rm -f "$DMG"
  STAGE="$(mktemp -d)"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -quiet -volname "MobyD" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
  rm -rf "$STAGE"
  echo "DMG: $DMG"
fi
