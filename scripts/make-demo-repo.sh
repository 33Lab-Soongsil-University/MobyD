#!/usr/bin/env bash
# Build a throwaway repository with branches, merges, tags, a stash, a
# worktree and uncommitted changes so every part of MobyD has something to show.
set -euo pipefail
DEST="${1:?usage: make-demo-repo.sh <dest-dir>}"
rm -rf "$DEST" "$DEST-wt-fluke" "$DEST-remote.git"
mkdir -p "$DEST"
cd "$DEST"
export GIT_AUTHOR_NAME="Ishmael Kim" GIT_AUTHOR_EMAIL="ishmael@pequod.test"
export GIT_COMMITTER_NAME="Ishmael Kim" GIT_COMMITTER_EMAIL="ishmael@pequod.test"
t=1767225600 # 2026-01-01
c() { # c <file> <content> <message> [author]
  local who="${4:-Ishmael Kim}"
  mkdir -p "$(dirname "$1")"
  echo "$2" >> "$1"
  git add "$1"
  t=$((t + 3600 * 7))
  GIT_AUTHOR_NAME="$who" GIT_COMMITTER_NAME="$who" GIT_AUTHOR_DATE="@$t" GIT_COMMITTER_DATE="@$t" git commit -q -m "$3"
}
git init -q -b main
c README.md "# Pequod" "Initial commit"
c src/pequod.ts "export const crew = [];" "Add pequod module"
git branch develop
c src/sea.ts "export const sea = 'blue';" "Add sea" "Starbuck Lee"
git switch -q develop
c src/lookout.ts "export function watch() {}" "Add lookout watch" "Starbuck Lee"
c src/lookout.ts "export function bearing() {}" "Add lookout bearing" "Starbuck Lee"
git switch -q -c feature/harpoon
c src/harpoon.ts "export const range = 30;" "Add harpoon range" "Queequeg Park"
c src/harpoon.ts "export const barbs = 2;" "Add barbs to harpoon" "Queequeg Park"
git switch -q develop
c src/lookout.ts "// tuned" "Tune lookout" "Starbuck Lee"
t=$((t + 3600)); GIT_AUTHOR_DATE="@$t" GIT_COMMITTER_DATE="@$t" git merge -q --no-ff feature/harpoon -m "Merge branch 'feature/harpoon' into develop"
git switch -q main
c README.md "Call me Ishmael." "Docs: opening line"
t=$((t + 3600)); GIT_AUTHOR_DATE="@$t" GIT_COMMITTER_DATE="@$t" git merge -q --no-ff develop -m "Merge branch 'develop'"
git tag -a v0.1.0 -m "First release"
git switch -q -c feature/spout
c src/spout.ts "export const height = 9;" "Spout height" "Ahab Moon"
git switch -q main
c src/pequod.ts "export const size = 30;" "Grow the crew"
git switch -q -c hotfix/fluke
c src/fluke.ts "export const scar = true;" "Mark the fluke scar" "Queequeg Park"
git switch -q main
git switch -q feature/spout
c src/spout.ts "export const angle = 45;" "Spout angle" "Ahab Moon"
git switch -q main
# bare "remote" so remote-tracking branches show up
git init -q --bare "$DEST-remote.git"
git remote add origin "$DEST-remote.git"
git push -q origin main develop feature/spout --tags
git branch -u origin/main main >/dev/null
c src/pequod.ts "// local only" "Local tweak not pushed"
# stash + worktree + dirty tree
echo "export const breach = 1;" > src/breach.ts
git add src/breach.ts
git stash push -q -m "WIP: whale breach"
git worktree add -q "$DEST-wt-fluke" hotfix/fluke
echo "export const splash = true;" > src/splash.ts
echo "// edited" >> README.md
echo "// staged edit" >> src/sea.ts
git add src/sea.ts
echo "demo repo ready: $DEST"
