#!/usr/bin/env bash
# Set the app version everywhere it is declared: package.json,
# src-tauri/tauri.conf.json, src-tauri/Cargo.toml (and Cargo.lock).
#   scripts/set-version.sh 0.2.0
set -euo pipefail
V="${1:?usage: scripts/set-version.sh <version, e.g. 0.2.0>}"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "not a semver version: $V" >&2; exit 1; }
cd "$(dirname "$0")/.."
node -e '
const fs = require("fs"), v = process.argv[1];
for (const f of ["package.json", "src-tauri/tauri.conf.json"]) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.version = v;
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
}' "$V"
# only the [package] version (first `version =` line) of the crate
awk -v v="$V" '!done && /^version = "/ { print "version = \"" v "\""; done = 1; next } { print }' src-tauri/Cargo.toml > src-tauri/Cargo.toml.tmp
mv src-tauri/Cargo.toml.tmp src-tauri/Cargo.toml
cargo update --manifest-path src-tauri/Cargo.toml -p mobyd --offline >/dev/null 2>&1 || cargo update --manifest-path src-tauri/Cargo.toml -p mobyd >/dev/null
echo "version set to $V"
