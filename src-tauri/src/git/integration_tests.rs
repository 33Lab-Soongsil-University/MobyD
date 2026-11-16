//! End-to-end tests against real repositories created with the git CLI.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::graph::{layout, SegmentKind};
use super::{log, ops, repo, runner, status};

struct Repo {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new(runner::git_bin())
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "Test Dolphin")
        .env("GIT_AUTHOR_EMAIL", "test@pod.test")
        .env("GIT_COMMITTER_NAME", "Test Dolphin")
        .env("GIT_COMMITTER_EMAIL", "test@pod.test")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .args(args)
        .output()
        .expect("git runs");
    assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn write(dir: &Path, file: &str, content: &str) {
    let p = dir.join(file);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, content).unwrap();
}

fn commit(dir: &Path, file: &str, content: &str, msg: &str) {
    write(dir, file, content);
    git(dir, &["add", file]);
    git(dir, &["commit", "-q", "-m", msg]);
}

fn new_repo() -> Repo {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pod");
    std::fs::create_dir_all(&path).unwrap();
    git(&path, &["init", "-q", "-b", "main"]);
    git(&path, &["config", "user.name", "Test Dolphin"]);
    git(&path, &["config", "user.email", "test@pod.test"]);
    git(&path, &["config", "commit.gpgsign", "false"]);
    Repo { _dir: dir, path }
}

/// main: a - b ----- m
///             \   /
/// feature:      f1
fn branchy() -> Repo {
    let r = new_repo();
    commit(&r.path, "a.txt", "a\n", "a");
    commit(&r.path, "b.txt", "b\n", "b");
    git(&r.path, &["switch", "-q", "-c", "feature"]);
    commit(&r.path, "f.txt", "f\n", "f1");
    git(&r.path, &["switch", "-q", "main"]);
    commit(&r.path, "c.txt", "c\n", "c");
    git(&r.path, &["merge", "-q", "--no-ff", "feature", "-m", "merge feature"]);
    r
}

#[test]
fn graph_from_real_history() {
    let r = branchy();
    let commits = log::load_commits(&r.path, 100).unwrap();
    assert_eq!(commits.len(), 5);
    assert_eq!(commits[0].subject, "merge feature");
    assert_eq!(commits[0].parents.len(), 2);
    let g = layout(commits.iter().map(|c| (c.hash.as_str(), c.parents.as_slice())));
    assert_eq!(g.rows.len(), 5);
    assert_eq!(g.max_lanes, 2);
    let leaves = g.rows[0].segments.iter().filter(|s| s.kind == SegmentKind::Leave).count();
    assert_eq!(leaves, 2, "merge commit leaves towards both parents");
    let refs = log::load_refs(&r.path).unwrap();
    assert!(refs.iter().any(|x| x.short == "main" && x.is_head));
    assert!(refs.iter().any(|x| x.short == "feature"));
    let head = log::head_info(&r.path).unwrap();
    assert_eq!(head.branch.as_deref(), Some("main"));
}

#[test]
fn empty_repository_has_no_commits() {
    let r = new_repo();
    assert!(log::load_commits(&r.path, 10).unwrap().is_empty());
    let head = log::head_info(&r.path).unwrap();
    assert!(head.unborn);
    write(&r.path, "new.txt", "x");
    let st = status::status(&r.path).unwrap();
    assert_eq!(st.unstaged.len(), 1);
    ops::stage(&r.path, &[]).unwrap();
    ops::unstage(&r.path, &["new.txt".into()]).unwrap();
    assert_eq!(status::status(&r.path).unwrap().staged.len(), 0);
}

#[test]
fn status_staging_commit_and_detail() {
    let r = branchy();
    write(&r.path, "a.txt", "a\nmore\n");
    write(&r.path, "new dir/n.txt", "n\n");
    git(&r.path, &["mv", "b.txt", "bee.txt"]);
    let st = status::status(&r.path).unwrap();
    assert!(st.unstaged.iter().any(|f| f.path == "a.txt" && f.status == "M"));
    assert!(st.unstaged.iter().any(|f| f.path == "new dir/n.txt" && f.status == "?"));
    assert!(st.staged.iter().any(|f| f.status == "R" && f.orig_path.as_deref() == Some("b.txt")));

    ops::stage(&r.path, &["a.txt".into(), "new dir/n.txt".into()]).unwrap();
    ops::commit(&r.path, "change things\n\nwith a body", false, false).unwrap();
    let head = log::head_info(&r.path).unwrap().commit.unwrap();
    let d = log::commit_detail(&r.path, &head).unwrap();
    assert_eq!(d.subject, "change things");
    assert_eq!(d.body, "with a body");
    let a = d.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert_eq!((a.additions, a.deletions), (Some(1), Some(0)));
    assert!(d.files.iter().any(|f| f.status == "R" && f.path == "bee.txt"));
    assert_eq!(ops::last_commit_message(&r.path).unwrap(), "change things\n\nwith a body");

    ops::commit(&r.path, "amended", true, false).unwrap();
    assert_eq!(ops::last_commit_message(&r.path).unwrap(), "amended");
}

#[test]
fn hunk_patch_stages_only_that_hunk() {
    let r = new_repo();
    let base: String = (1..=30).map(|i| format!("line {i}\n")).collect();
    commit(&r.path, "f.txt", &base, "base");
    let changed = base.replace("line 2\n", "line two\n").replace("line 28\n", "line twenty-eight\n");
    write(&r.path, "f.txt", &changed);
    let diff = ops::diff(
        &r.path,
        &ops::DiffRequest {
            kind: "unstaged".into(),
            path: "f.txt".into(),
            orig_path: None,
            sha: None,
            context: None,
            ignore_whitespace: false,
        },
    )
    .unwrap();
    let header_end = diff.find("@@").unwrap();
    let second = diff[header_end + 2..].find("\n@@").map(|i| i + header_end + 3).unwrap();
    let patch = format!("{}{}", &diff[..header_end], &diff[header_end..second]);
    ops::apply_patch(&r.path, &patch, true, false).unwrap();
    let staged = ops::diff(
        &r.path,
        &ops::DiffRequest {
            kind: "staged".into(),
            path: "f.txt".into(),
            orig_path: None,
            sha: None,
            context: None,
            ignore_whitespace: false,
        },
    )
    .unwrap();
    assert!(staged.contains("+line two"));
    assert!(!staged.contains("twenty-eight"));
    // and unstage it again
    ops::apply_patch(&r.path, &patch, true, true).unwrap();
    assert!(status::status(&r.path).unwrap().staged.is_empty());
}

#[test]
fn branches_tags_and_reset() {
    let r = branchy();
    ops::create_branch(&r.path, "topic/x", Some("HEAD~1"), false).unwrap();
    ops::rename_branch(&r.path, "topic/x", "topic/y").unwrap();
    ops::create_tag(&r.path, "v1", "HEAD", Some("release")).unwrap();
    let refs = log::load_refs(&r.path).unwrap();
    assert!(refs.iter().any(|x| x.short == "topic/y"));
    let tag = refs.iter().find(|x| x.short == "v1").unwrap();
    assert_eq!(tag.target, log::head_info(&r.path).unwrap().commit.unwrap(), "annotated tag is peeled");
    ops::checkout_branch(&r.path, "topic/y").unwrap();
    assert_eq!(log::head_info(&r.path).unwrap().branch.as_deref(), Some("topic/y"));
    ops::checkout_branch(&r.path, "main").unwrap();
    ops::delete_branch(&r.path, "topic/y", false).unwrap();
    ops::delete_tag(&r.path, "v1").unwrap();
    ops::reset(&r.path, "HEAD~1", "hard").unwrap();
    assert_eq!(log::commit_detail(&r.path, "HEAD").unwrap().subject, "c", "hard reset to first parent of the merge");
    assert!(ops::create_branch(&r.path, "--evil", None, false).is_err());
}

#[test]
fn merge_conflict_detect_and_resolve() {
    let r = new_repo();
    commit(&r.path, "x.txt", "base\n", "base");
    git(&r.path, &["switch", "-q", "-c", "other"]);
    commit(&r.path, "x.txt", "theirs\n", "theirs");
    git(&r.path, &["switch", "-q", "main"]);
    commit(&r.path, "x.txt", "ours\n", "ours");
    let out = ops::merge(&r.path, "other", "ff", None).unwrap();
    assert!(!out.ok && out.conflicts, "merge should report conflicts: {}", out.message);
    let st = repo::state(&r.path).unwrap();
    assert_eq!(st.operation.as_deref(), Some("merge"));
    assert_eq!(st.message.as_deref(), Some("Merge branch 'other'"));
    assert_eq!(status::status(&r.path).unwrap().conflicted.len(), 1);
    ops::resolve_conflict(&r.path, "x.txt", "theirs").unwrap();
    assert!(status::status(&r.path).unwrap().conflicted.is_empty());
    let done = ops::sequencer(&r.path, "merge", "continue").unwrap();
    assert!(done.ok, "{}", done.message);
    assert!(repo::state(&r.path).unwrap().operation.is_none());
    assert_eq!(std::fs::read_to_string(r.path.join("x.txt")).unwrap(), "theirs\n");

    // abort path
    git(&r.path, &["switch", "-q", "-c", "again", "HEAD~1"]);
    commit(&r.path, "x.txt", "again\n", "again");
    let out = ops::merge(&r.path, "main", "no-ff", None).unwrap();
    assert!(out.conflicts);
    ops::sequencer(&r.path, "merge", "abort").unwrap();
    assert!(repo::state(&r.path).unwrap().operation.is_none());
}

#[test]
fn cherry_pick_revert_and_rebase() {
    let r = branchy();
    git(&r.path, &["switch", "-q", "-c", "side", "HEAD~2"]);
    commit(&r.path, "s.txt", "s\n", "side work");
    let side_sha = log::head_info(&r.path).unwrap().commit.unwrap();
    git(&r.path, &["switch", "-q", "main"]);
    assert!(ops::cherry_pick(&r.path, &side_sha).unwrap().ok);
    assert!(r.path.join("s.txt").exists());
    let head = log::head_info(&r.path).unwrap().commit.unwrap();
    assert!(ops::revert(&r.path, &head).unwrap().ok);
    assert!(!r.path.join("s.txt").exists());
    // `side work` is already upstream (cherry-picked), so rebase a fresh branch instead.
    git(&r.path, &["switch", "-q", "-c", "side2", "HEAD~4"]);
    commit(&r.path, "t.txt", "t\n", "more side work");
    assert!(ops::rebase(&r.path, "main").unwrap().ok);
    let head = log::commit_detail(&r.path, "HEAD").unwrap();
    assert_eq!(head.subject, "more side work");
    let main_sha = git(&r.path, &["rev-parse", "main"]).trim().to_string();
    assert_eq!(head.parents, vec![main_sha], "side now sits on top of main");
}

#[test]
fn stash_roundtrip() {
    let r = branchy();
    write(&r.path, "a.txt", "changed\n");
    write(&r.path, "u.txt", "untracked\n");
    ops::stash_save(&r.path, Some("dolphin wip"), true, false).unwrap();
    assert!(!status::status(&r.path).unwrap().is_dirty());
    let stashes = repo::stashes(&r.path).unwrap();
    assert_eq!(stashes.len(), 1);
    assert!(stashes[0].message.contains("dolphin wip"));
    assert_eq!(stashes[0].base, log::head_info(&r.path).unwrap().commit);
    assert!(ops::stash_action(&r.path, "pop", 0).unwrap().ok);
    assert!(r.path.join("u.txt").exists());
    assert!(repo::stashes(&r.path).unwrap().is_empty());
}

#[test]
fn worktree_lifecycle() {
    let r = branchy();
    let wt = r.path.parent().unwrap().join("pod-feature");
    ops::worktree_add(
        &r.path,
        &ops::WorktreeAdd {
            path: wt.to_string_lossy().into(),
            branch: Some("feature".into()),
            new_branch: false,
            start: None,
            detach: false,
        },
    )
    .unwrap();
    let wt2 = r.path.parent().unwrap().join("pod-new");
    ops::worktree_add(
        &r.path,
        &ops::WorktreeAdd {
            path: wt2.to_string_lossy().into(),
            branch: Some("brand-new".into()),
            new_branch: true,
            start: Some("HEAD~1".into()),
            detach: false,
        },
    )
    .unwrap();
    let list = repo::worktrees(&r.path).unwrap();
    assert_eq!(list.len(), 3);
    assert!(list[0].is_main && list[0].is_current);
    assert!(list.iter().any(|w| w.branch.as_deref() == Some("feature")));
    let info = repo::open(&wt).unwrap();
    assert!(info.is_worktree);
    let from_wt = repo::worktrees(&wt).unwrap();
    assert!(from_wt.iter().any(|w| w.is_current && w.branch.as_deref() == Some("feature")));
    ops::worktree_lock(&r.path, &wt2.to_string_lossy(), true, Some("testing")).unwrap();
    assert!(repo::worktrees(&r.path).unwrap().iter().any(|w| w.locked));
    ops::worktree_lock(&r.path, &wt2.to_string_lossy(), false, None).unwrap();
    ops::worktree_remove(&r.path, &wt.to_string_lossy(), false).unwrap();
    std::fs::remove_dir_all(&wt2).unwrap();
    ops::worktree_prune(&r.path).unwrap();
    assert_eq!(repo::worktrees(&r.path).unwrap().len(), 1);
}

#[test]
fn remotes_push_pull_and_review_refs() {
    let r = branchy();
    let bare = r.path.parent().unwrap().join("remote.git");
    git(r.path.parent().unwrap(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
    ops::add_remote(&r.path, "origin", bare.to_str().unwrap()).unwrap();
    assert_eq!(repo::remotes(&r.path).unwrap()[0].name, "origin");
    ops::push(&r.path, Some("origin"), Some("main"), true, false, &[]).unwrap();
    let refs = log::load_refs(&r.path).unwrap();
    let main = refs.iter().find(|x| x.short == "main").unwrap();
    assert_eq!(main.upstream.as_deref(), Some("origin/main"));

    // simulate a forge PR ref on the remote
    let feature = git(&r.path, &["rev-parse", "feature"]).trim().to_string();
    git(&bare, &["update-ref", "refs/pull/7/head", &feature]);
    ops::checkout_review_ref(&r.path, "origin", "refs/pull/7/head", "pr/7").unwrap();
    assert_eq!(log::head_info(&r.path).unwrap().branch.as_deref(), Some("pr/7"));
    assert_eq!(log::head_info(&r.path).unwrap().commit.as_deref(), Some(feature.as_str()));

    git(&r.path, &["switch", "-q", "main"]);
    ops::fetch(&r.path, None, true, &[]).unwrap();
    assert!(ops::pull(&r.path, "ff-only", &[]).unwrap().ok);
    ops::remove_remote(&r.path, "origin").unwrap();
    assert!(repo::remotes(&r.path).unwrap().is_empty());
}

#[test]
fn fingerprint_changes_with_worktree() {
    let r = branchy();
    let a = repo::fingerprint(&r.path).unwrap();
    assert_eq!(a, repo::fingerprint(&r.path).unwrap());
    write(&r.path, "z.txt", "z");
    assert_ne!(a, repo::fingerprint(&r.path).unwrap());
}

#[test]
fn fast_forward_without_checkout_and_worktree_validation() {
    let r = branchy();
    let bare = r.path.parent().unwrap().join("ff.git");
    git(r.path.parent().unwrap(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
    ops::add_remote(&r.path, "origin", bare.to_str().unwrap()).unwrap();
    git(&r.path, &["push", "-q", "origin", "feature"]);
    // advance origin/feature by pushing a new commit from a temporary branch
    git(&r.path, &["switch", "-q", "-c", "tmp", "feature"]);
    commit(&r.path, "g.txt", "g\n", "g");
    git(&r.path, &["push", "-q", "origin", "tmp:feature"]);
    git(&r.path, &["fetch", "-q", "origin"]);
    git(&r.path, &["switch", "-q", "main"]);
    let before = git(&r.path, &["rev-parse", "feature"]);
    ops::fast_forward_branch(&r.path, "feature", "origin/feature").unwrap();
    let after = git(&r.path, &["rev-parse", "feature"]);
    assert_ne!(before, after);
    assert_eq!(after, git(&r.path, &["rev-parse", "origin/feature"]));
    assert!(ops::fast_forward_branch(&r.path, "main", "origin/feature").is_err(), "current branch refused");

    let occupied = r.path.parent().unwrap().join("occupied");
    write(&occupied, "x.txt", "x");
    let err = ops::worktree_add(
        &r.path,
        &ops::WorktreeAdd {
            path: occupied.to_string_lossy().into(),
            branch: Some("x".into()),
            new_branch: true,
            start: None,
            detach: false,
        },
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("비어 있지 않습니다"), "{err}");
    let err = ops::worktree_add(
        &r.path,
        &ops::WorktreeAdd {
            path: r.path.parent().unwrap().join("fresh").to_string_lossy().into(),
            branch: Some("feature".into()),
            new_branch: true,
            start: None,
            detach: false,
        },
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("이미 있습니다"), "{err}");
}

// ----- SSH code path, exercised through a fake `ssh` that runs the remote command locally ----------

/// A fake `ssh` that runs the remote command on this machine. The host name
/// picks the login shell it pretends to have:
/// * `fakehost`     — POSIX shell
/// * `fakecmd`      — Windows cmd.exe (with `cmd /c` quote stripping) + Git for Windows
/// * `fakeps`       — Windows PowerShell (CRLF output, Git's `uname` on PATH)
/// * `fakemislead`  — answers the probe like a POSIX shell but only runs cmd-style lines
/// * `fakeoverride` — like `fakecmd`, used by the override test
fn fake_ssh() -> &'static Path {
    static FAKE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    FAKE.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("mobyd-fake-ssh-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("ssh");
        std::fs::write(
            &script,
            r#"#!/bin/bash
for a in "$@"; do [ "$a" = -G ] && exit 0; done
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
shift; host="$1"; cmd="$2"
BASH_WIN='C:\Program Files\Git\bin\bash.exe'
where_out() { printf 'C:\\Program Files\\Git\\mingw64\\bin\\git.exe\r\nC:\\Program Files\\Git\\cmd\\git.exe\r\n'; }
# Git for Windows ships bash 5; macOS /bin/bash 3.2 cannot `source <(...)`, so run the decoded script directly.
run_git_bash() {
  local hp='source <(head -c ' hs=') </dev/null'
  case "$1" in "$hp"*"$hs")
    local n="${1#"$hp"}"; n="${n%"$hs"}"; script=$(head -c "$n"); exec /bin/bash -c "$script" </dev/null;; esac
  case "$1" in "source <(echo "*"|base64 -d)") ;; *) echo "bash: unexpected script: $1" >&2; exit 2;; esac
  local pre='source <(echo ' suf='|base64 -d)'
  local b64="${1#"$pre"}"; b64="${b64%"$suf"}"
  exec /bin/bash -c "$(printf %s "$b64" | base64 -d)"
}
run_cmd_style() {
  [ "${#cmd}" -gt 8180 ] && { echo "The command line is too long." >&2; exit 1; }
  # cmd /c: a line that starts with a quote loses its first and last quote
  if [ "${cmd:0:1}" = '"' ]; then cmd="${cmd#\"}"; cmd="${cmd%\"}"; fi
  local prefix="\"$BASH_WIN\" -c \""
  case "$cmd" in "$prefix"*) inner="${cmd#"$prefix"}"; inner="${inner%\"}"; run_git_bash "$inner";; esac
  echo "'${cmd%% *}' is not recognized as an internal or external command," >&2; exit 1
}
case "$host" in
  fakecmd|fakeoverride)
    [ "$cmd" = "echo __DLP__; uname -s" ] && { printf '__DLP__; uname -s\r\n'; exit 0; }
    [ "$cmd" = "where.exe git" ] && { where_out; exit 0; }
    run_cmd_style ;;
  fakemislead)
    [ "$cmd" = "echo __DLP__; uname -s" ] && { printf '__DLP__\nLinux\n'; exit 0; }
    [ "$cmd" = "where.exe git" ] && { where_out; exit 0; }
    run_cmd_style ;;
  fakeps)
    [ "$cmd" = "echo __DLP__; uname -s" ] && { printf '__DLP__\r\nMINGW64_NT-10.0-26200\n'; exit 0; }
    [ "$cmd" = "where.exe git" ] && { where_out; exit 0; }
    [ "${#cmd}" -gt 32000 ] && { echo "Program 'bash.exe' failed to run: The filename or extension is too long" >&2; exit 1; }
    prefix="& '$BASH_WIN' -c '"
    case "$cmd" in "$prefix"*) inner="${cmd#"$prefix"}"; inner="${inner%\'}"; run_git_bash "$inner";; esac
    echo "The term is not recognized as the name of a cmdlet" >&2; exit 1 ;;
  # Windows OpenSSH under load: the channel's input never reaches EOF
  fakenoeof)
    fifo=$(mktemp -u "${TMPDIR:-/tmp}/noeof.XXXXXX"); mkfifo "$fifo"
    exec 3<&0
    { cat <&3; exec 3<&-; sleep 120; } >"$fifo" 2>/dev/null </dev/null &
    exec 3<&- 4<"$fifo"; rm -f "$fifo"
    exec /bin/sh -c "$cmd" <&4 4<&- ;;
  # the shared connection died while the laptop slept: fails once, then works
  fakestale-*|fakerefused-*)
    mark="${TMPDIR:-/tmp}/mobyd-$host.seen"
    echo x >>"${TMPDIR:-/tmp}/mobyd-$host.log"
    if [ ! -e "$mark" ]; then
      : >"$mark"
      case "$host" in
        fakestale-*) echo "mux_client_request_session: read from master failed: Broken pipe" >&2 ;;
        *) echo "Control socket connect(/tmp/mobyd/abc): Connection refused" >&2 ;;
      esac
      exit 255
    fi
    exec /bin/sh -c "$cmd" ;;
  # refuses the connection without reading what is sent
  fakedeny) echo "user@fakedeny: Permission denied (publickey)." >&2; exit 255 ;;
  # slow to answer; logs when each command starts and ends
  fakeslow-*)
    log="${TMPDIR:-/tmp}/mobyd-$host.log"
    echo S >>"$log"; sleep 0.3; /bin/sh -c "$cmd"; rc=$?; echo E >>"$log"; exit $rc ;;
  # unreachable, after a wait
  fakedown-*)
    echo x >>"${TMPDIR:-/tmp}/mobyd-$host.log"; sleep 0.4
    echo "ssh: connect to host $host port 22: Operation timed out" >&2; exit 255 ;;
  *) exec /bin/sh -c "$cmd" ;;
esac
"#,
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::env::set_var("MOBYD_SSH", &script);
        script
    })
}

fn remote_on(host: &str, local: &Path) -> PathBuf {
    fake_ssh();
    let canon = std::fs::canonicalize(local).unwrap();
    PathBuf::from(super::remote::uri(host, &canon.to_string_lossy()))
}

fn as_remote(local: &Path) -> PathBuf {
    remote_on("fakehost", local)
}

#[test]
fn remote_snapshot_matches_local() {
    let r = branchy();
    write(&r.path, "a.txt", "dirty\n");
    write(&r.path, "space dir/n.txt", "n\n");
    let remote_path = as_remote(&r.path);

    let info = repo::open(&remote_path).unwrap();
    assert_eq!(info.host.as_deref(), Some("fakehost"));
    assert!(info.root.starts_with("ssh://fakehost/"));
    assert!(info.name.ends_with("@ fakehost"));

    let local = super::snapshot::load(&r.path, 100).unwrap();
    let remote = super::snapshot::load(&remote_path, 100).unwrap();
    assert_eq!(remote.commits, local.commits);
    assert_eq!(remote.refs, local.refs);
    assert_eq!(remote.status, local.status);
    assert_eq!(remote.head.commit, local.head.commit);
    assert_eq!(remote.fingerprint, local.fingerprint, "same bytes → same fingerprint");
    assert!(remote.worktrees[0].open_path.starts_with("ssh://fakehost/"));
    assert!(remote.worktrees[0].is_current);
}

#[test]
fn remote_writes_with_stdin_and_conflict_state() {
    let r = new_repo();
    commit(&r.path, "x.txt", "base\n", "base");
    git(&r.path, &["switch", "-q", "-c", "other"]);
    commit(&r.path, "x.txt", "theirs\n", "theirs");
    git(&r.path, &["switch", "-q", "main"]);
    let rp = as_remote(&r.path);

    write(&r.path, "x.txt", "ours 'quoted' $HOME `x`\n");
    ops::stage(&rp, &["x.txt".into()]).unwrap();
    ops::commit(&rp, "ours with 'quotes' and $dollar\n\nbody line", false, false).unwrap();
    assert_eq!(ops::last_commit_message(&r.path).unwrap(), "ours with 'quotes' and $dollar\n\nbody line");

    let out = ops::merge(&rp, "other", "ff", None).unwrap();
    assert!(out.conflicts);
    let snap = super::snapshot::load(&rp, 50).unwrap();
    assert_eq!(snap.state.operation.as_deref(), Some("merge"));
    assert_eq!(snap.state.message.as_deref(), Some("Merge branch 'other'"));
    assert_eq!(snap.status.conflicted.len(), 1);
    ops::sequencer(&rp, "merge", "abort").unwrap();
    assert!(super::snapshot::load(&rp, 50).unwrap().state.operation.is_none());
}

#[test]
fn remote_directory_listing_and_init() {
    let r = branchy();
    fake_ssh();
    let parent = std::fs::canonicalize(r.path.parent().unwrap()).unwrap();
    let listing = super::remote::list_dir("fakehost", &parent.to_string_lossy()).unwrap();
    assert_eq!(listing.path, parent.to_string_lossy());
    assert!(listing.entries.iter().any(|e| e.name == "pod" && e.is_repo));
    assert!(listing.git_version.is_some());
    let inside = super::remote::list_dir("fakehost", &parent.join("pod").to_string_lossy()).unwrap();
    assert!(inside.is_repo);

    let fresh = parent.join("fresh-remote");
    ops::init(&PathBuf::from(super::remote::uri("fakehost", &fresh.to_string_lossy()))).unwrap();
    assert!(fresh.join(".git").exists());
    assert!(super::remote::list_dir("fakehost", "/definitely/not/here").is_err());
}

// ----- undo / redo, interactive rebase, blame ------------------------------------------------

use crate::commands as cmd;
use tauri::async_runtime::block_on;

fn key(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn head_subject(p: &Path) -> String {
    log::commit_detail(p, "HEAD").unwrap().subject
}

#[test]
fn undo_redo_commit_checkout_branch_and_discard() {
    let r = branchy();
    let k = key(&r.path);
    crate::journal::clear(&k);

    // commit → undo keeps the change staged → redo restores the commit
    write(&r.path, "u.txt", "u\n");
    ops::stage(&r.path, &["u.txt".into()]).unwrap();
    block_on(cmd::commit_create(k.clone(), "undo me".into(), false)).unwrap();
    assert_eq!(head_subject(&r.path), "undo me");
    assert_eq!(crate::journal::state(&k).undo.as_deref(), Some("커밋"));
    block_on(cmd::undo(k.clone())).unwrap();
    assert_eq!(head_subject(&r.path), "merge feature");
    assert_eq!(status::status(&r.path).unwrap().staged[0].path, "u.txt");
    block_on(cmd::redo(k.clone())).unwrap();
    assert_eq!(head_subject(&r.path), "undo me");

    // create + checkout a branch → undo returns to main and removes it
    block_on(cmd::branch_create(k.clone(), "topic".into(), Some("HEAD~1".into()), true)).unwrap();
    assert_eq!(log::head_info(&r.path).unwrap().branch.as_deref(), Some("topic"));
    block_on(cmd::undo(k.clone())).unwrap();
    assert_eq!(log::head_info(&r.path).unwrap().branch.as_deref(), Some("main"));
    assert!(crate::journal::ref_value(&r.path, "refs/heads/topic").is_none());
    block_on(cmd::redo(k.clone())).unwrap();
    assert_eq!(log::head_info(&r.path).unwrap().branch.as_deref(), Some("topic"));
    git(&r.path, &["switch", "-q", "main"]);

    // delete a branch → undo brings it back at the same commit
    let feature = crate::journal::ref_value(&r.path, "refs/heads/feature");
    block_on(cmd::branch_delete(k.clone(), "feature".into(), true)).unwrap();
    block_on(cmd::undo(k.clone())).unwrap();
    assert_eq!(crate::journal::ref_value(&r.path, "refs/heads/feature"), feature);

    // discard → undo re-applies the edit
    write(&r.path, "a.txt", "a\nedited\n");
    block_on(cmd::discard_paths(k.clone(), vec!["a.txt".into()], vec![])).unwrap();
    assert_eq!(std::fs::read_to_string(r.path.join("a.txt")).unwrap(), "a\n");
    block_on(cmd::undo(k.clone())).unwrap();
    assert_eq!(std::fs::read_to_string(r.path.join("a.txt")).unwrap(), "a\nedited\n");

    // external changes make undo refuse instead of clobbering
    block_on(cmd::commit_create(k.clone(), "x".into(), false)).ok();
    commit(&r.path, "ext.txt", "ext\n", "made in a terminal");
    assert!(block_on(cmd::undo(k.clone())).is_err());
}

#[test]
fn interactive_rebase_reword_squash_drop_and_undo() {
    let r = new_repo();
    for i in 1..=5 {
        commit(&r.path, &format!("f{i}.txt"), &format!("{i}\n"), &format!("c{i}"));
    }
    let k = key(&r.path);
    crate::journal::clear(&k);
    let base = git(&r.path, &["rev-parse", "HEAD~4"]).trim().to_string();
    let original = git(&r.path, &["rev-parse", "HEAD"]).trim().to_string();
    let plan = block_on(cmd::rebase_plan(k.clone(), base.clone())).unwrap();
    assert_eq!(plan.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), vec!["c2", "c3", "c4", "c5"]);
    let h = |i: usize| plan.commits[i].hash.clone();
    let steps = vec![
        super::history::RebaseStep {
            action: "reword".into(),
            hash: h(0),
            message: Some("second, renamed\n\nwith 'quotes' & $vars".into()),
        },
        super::history::RebaseStep { action: "pick".into(), hash: h(1), message: None },
        super::history::RebaseStep { action: "squash".into(), hash: h(2), message: Some("c3 + c4".into()) },
        super::history::RebaseStep { action: "drop".into(), hash: h(3), message: None },
    ];
    let out = block_on(cmd::rebase_interactive(k.clone(), base, steps)).unwrap();
    assert!(out.ok, "{}", out.message);
    let subjects = git(&r.path, &["log", "--format=%s", "-3"]);
    assert_eq!(subjects.lines().collect::<Vec<_>>(), vec!["c3 + c4", "second, renamed", "c1"]);
    assert_eq!(log::commit_detail(&r.path, "HEAD~1").unwrap().body, "with 'quotes' & $vars");
    assert!(!r.path.join("f5.txt").exists(), "dropped commit is gone");
    assert!(r.path.join("f4.txt").exists(), "squashed content kept");

    block_on(cmd::undo(k.clone())).unwrap();
    assert_eq!(git(&r.path, &["rev-parse", "HEAD"]).trim(), original);
}

#[test]
fn blame_lines_and_uncommitted_edits() {
    let r = new_repo();
    commit(&r.path, "b.txt", "one\ntwo\n", "first");
    commit(&r.path, "b.txt", "one\ntwo\nthree\n", "second");
    write(&r.path, "b.txt", "one\nTWO\nthree\n");
    let b = super::history::blame(&r.path, "b.txt", None).unwrap();
    assert_eq!(b.lines.len(), 3);
    assert_eq!(b.commits[&b.lines[0].hash].summary, "first");
    assert!(b.commits[&b.lines[1].hash].uncommitted);
    assert_eq!(b.commits[&b.lines[2].hash].summary, "second");
    let at = super::history::blame(&r.path, "b.txt", Some("HEAD~1")).unwrap();
    assert_eq!(at.lines.len(), 2);
}

#[test]
fn remote_interactive_rebase_and_undo_over_ssh() {
    let r = new_repo();
    for i in 1..=3 {
        commit(&r.path, &format!("f{i}.txt"), &format!("{i}\n"), &format!("c{i}"));
    }
    let rp = as_remote(&r.path);
    let k = key(&rp);
    crate::journal::clear(&k);
    let base = git(&r.path, &["rev-parse", "HEAD~2"]).trim().to_string();
    let plan = block_on(cmd::rebase_plan(k.clone(), base.clone())).unwrap();
    let steps = vec![
        super::history::RebaseStep { action: "pick".into(), hash: plan.commits[0].hash.clone(), message: None },
        super::history::RebaseStep { action: "fixup".into(), hash: plan.commits[1].hash.clone(), message: None },
    ];
    let out = block_on(cmd::rebase_interactive(k.clone(), base, steps)).unwrap();
    assert!(out.ok, "{}", out.message);
    assert_eq!(git(&r.path, &["log", "--format=%s", "-2"]).lines().collect::<Vec<_>>(), vec!["c2", "c1"]);
    block_on(cmd::undo(k.clone())).unwrap();
    assert_eq!(head_subject(&r.path), "c3");
    let b = super::history::blame(&rp, "f1.txt", None).unwrap();
    assert_eq!(b.lines[0].text, "1");
}

/// Full pipeline through a host whose login shell is cmd.exe or PowerShell.
fn windows_default_shell_pipeline(host: &str, expect: &str) {
    let r = branchy();
    write(&r.path, "a.txt", "dirty\n");
    let rp = remote_on(host, &r.path);
    let shell = super::remote::shell(host).unwrap();
    assert!(super::remote::describe(&shell).starts_with(expect), "{host}: {shell:?}");

    let info = repo::open(&rp).unwrap();
    assert!(info.root.starts_with(&format!("ssh://{host}/")));
    let local = super::snapshot::load(&r.path, 100).unwrap();
    let remote = super::snapshot::load(&rp, 100).unwrap();
    assert_eq!(remote.commits, local.commits);
    assert_eq!(remote.status, local.status);
    assert_eq!(remote.fingerprint, local.fingerprint);

    // writes with tricky characters travel through stdin untouched
    ops::stage(&rp, &["a.txt".into()]).unwrap();
    let k = key(&rp);
    crate::journal::clear(&k);
    block_on(cmd::commit_create(k.clone(), "it's \"quoted\" $HOME %PATH% `x`".into(), false)).unwrap();
    assert_eq!(head_subject(&r.path), "it's \"quoted\" $HOME %PATH% `x`");
    block_on(cmd::undo(k.clone())).unwrap();
    assert_eq!(head_subject(&r.path), "merge feature");
    block_on(cmd::redo(k.clone())).unwrap();

    let base = git(&r.path, &["rev-parse", "HEAD~2"]).trim().to_string();
    let plan = block_on(cmd::rebase_plan(k.clone(), base.clone())).unwrap();
    assert!(!plan.commits.is_empty());
    let b = super::history::blame(&rp, "a.txt", None).unwrap();
    assert_eq!(b.lines[0].text, "dirty");
    let parent = std::fs::canonicalize(r.path.parent().unwrap()).unwrap();
    let l = super::remote::list_dir(host, &parent.to_string_lossy()).unwrap();
    assert!(l.entries.iter().any(|e| e.name == "pod" && e.is_repo));
    assert!(l.shell.starts_with(expect));
}

#[test]
fn remote_cmd_default_shell_full_pipeline() {
    windows_default_shell_pipeline("fakecmd", "Windows cmd");
}

#[test]
fn remote_powershell_default_shell_full_pipeline() {
    windows_default_shell_pipeline("fakeps", "Windows PowerShell");
}

#[test]
fn misdetected_shell_falls_back_to_a_working_strategy() {
    // The probe looks like Linux, but only cmd-style lines run: verification moves on to cmd.
    windows_default_shell_pipeline("fakemislead", "Windows cmd");
}

#[test]
fn per_host_shell_override_is_respected() {
    fake_ssh();
    let mut prefs = std::collections::HashMap::new();
    prefs.insert(
        "fakeoverride".to_string(),
        super::remote::HostPrefs { shell: super::remote::ShellPref::Powershell, address: None },
    );
    super::remote::set_host_prefs(prefs);
    let err = super::remote::shell("fakeoverride").unwrap_err().to_string();
    assert!(err.contains("지정한 방식(PowerShell)"), "{err}");
    super::remote::set_host_prefs(std::collections::HashMap::new());
    let s = super::remote::shell("fakeoverride").unwrap();
    assert!(matches!(s, super::remote::Shell::WinCmd { .. }), "auto detection after clearing the override: {s:?}");
}

/// Scripts larger than any Windows command line still run, stdin included.
fn oversized_scripts_on(host: &str) {
    let r = branchy();
    for i in 0..300 {
        write(&r.path, &format!("dir with spaces/a fairly long file name number {i:03}.txt"), "x\n");
    }
    let rp = remote_on(host, &r.path);
    let names: Vec<String> = (0..300).map(|i| format!("dir with spaces/a fairly long file name number {i:03}.txt")).collect();
    ops::stage(&rp, &names).unwrap();
    let st = super::status::status(&r.path).unwrap();
    assert_eq!(st.staged.len(), 300, "{host}");
    let padding = format!("# {}\n", "p".repeat(40_000));
    let out = super::remote::run_script(host, &format!("{padding}cat\n"), Some(b"it's \"stdin\" $HOME %PATH%\n")).unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "it's \"stdin\" $HOME %PATH%\n", "{host}");
    let snap = super::snapshot::load(&rp, 100).unwrap();
    assert_eq!(snap.status.staged.len(), 300);
}

#[test]
fn oversized_scripts_over_posix() {
    oversized_scripts_on("fakehost");
}

#[test]
fn oversized_scripts_over_cmd() {
    oversized_scripts_on("fakecmd");
}

#[test]
fn oversized_scripts_over_powershell() {
    oversized_scripts_on("fakeps");
}

/// A host whose ssh channel never delivers end-of-input (seen on Windows' OpenSSH
/// server with several commands sharing one connection) must not hang anything:
/// big scripts, piped input and the snapshot all finish without waiting for EOF.
#[test]
fn input_without_eof_does_not_hang() {
    let r = branchy();
    for i in 0..300 {
        write(&r.path, &format!("dir with spaces/a fairly long file name number {i:03}.txt"), "x\n");
    }
    let rp = remote_on("fakenoeof", &r.path);
    let started = std::time::Instant::now();
    let names: Vec<String> = (0..300).map(|i| format!("dir with spaces/a fairly long file name number {i:03}.txt")).collect();
    ops::stage(&rp, &names).unwrap();
    let out = super::remote::run_script("fakenoeof", "cat\n", Some(b"piped\n")).unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "piped\n");
    let snap = super::snapshot::load(&rp, 100).unwrap();
    assert_eq!(snap.status.staged.len(), 300);
    assert!(started.elapsed() < std::time::Duration::from_secs(60), "waited for EOF: {:?}", started.elapsed());
}

fn fake_state(host: &str) -> (PathBuf, PathBuf) {
    fake_ssh();
    let dir = std::env::temp_dir();
    let (log, seen) = (dir.join(format!("mobyd-{host}.log")), dir.join(format!("mobyd-{host}.seen")));
    let _ = std::fs::remove_file(&log);
    let _ = std::fs::remove_file(&seen);
    (log, seen)
}

fn log_lines(log: &Path) -> Vec<String> {
    std::fs::read_to_string(log).unwrap_or_default().lines().map(String::from).collect()
}

/// A read whose shared connection died (sleep, network change) is sent again
/// on a fresh connection, whether it travels on the command line or as stdin.
#[test]
fn stale_connection_is_retried_for_reads() {
    let (log, _) = fake_state("fakestale-read");
    let out = super::remote::run_ssh("fakestale-read", "echo hello", None).unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "hello\n");
    assert_eq!(log_lines(&log).len(), 2);

    let (log, _) = fake_state("fakestale-stdin");
    let out = super::remote::run_ssh("fakestale-stdin", "cat", Some(b"payload\n")).unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "payload\n", "stdin is sent again with the retry");
    assert_eq!(log_lines(&log).len(), 2);
}

/// A change is not sent twice when the connection broke at a point where it
/// may already have run; it is when ssh never got to hand it over.
#[test]
fn changes_are_only_retried_when_they_never_started() {
    let (log, _) = fake_state("fakestale-write");
    {
        let _m = super::remote::mutating();
        let out = super::remote::run_ssh("fakestale-write", "echo changed", None).unwrap();
        assert_eq!(out.status.code(), Some(255), "reported, not repeated");
        assert_eq!(log_lines(&log).len(), 1);
    }
    let (log, _) = fake_state("fakerefused-write");
    let _m = super::remote::mutating();
    let out = super::remote::run_ssh("fakerefused-write", "echo changed", None).unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "changed\n");
    assert_eq!(log_lines(&log).len(), 2);
}

/// ssh that fails before reading its input must report its own error, not a
/// broken pipe from our side (and must not be left behind as a zombie).
#[test]
fn connection_failure_with_pending_input_reports_the_ssh_error() {
    fake_ssh();
    let big = vec![b'x'; 2 * 1024 * 1024];
    let out = super::remote::run_ssh("fakedeny", "cat", Some(&big)).unwrap();
    assert_eq!(out.status.code(), Some(255));
    let e = super::remote::ssh_error("fakedeny", &out).unwrap().to_string();
    assert!(e.contains("Permission denied"), "{e}");
}

/// Commands that arrive together on a host with no connection yet do not all
/// connect at once: the first one finishes before any other starts.
#[test]
fn first_contact_opens_one_connection() {
    let (log, _) = fake_state("fakeslow-gate");
    std::thread::scope(|s| {
        for i in 0..6 {
            s.spawn(move || {
                let out = super::remote::run_ssh("fakeslow-gate", &format!("echo {i}"), None).unwrap();
                assert_eq!(String::from_utf8_lossy(&out.stdout), format!("{i}\n"));
            });
        }
    });
    let lines = log_lines(&log);
    assert_eq!(lines.len(), 12);
    assert_eq!(&lines[..2], ["S", "E"], "the first command had the host to itself: {lines:?}");
    assert!(lines[2..].windows(2).any(|w| w == ["S", "S"]), "afterwards they run side by side: {lines:?}");
}

/// When the host is unreachable, commands that were waiting share the one
/// failure instead of each sitting through the timeout; a later one tries again.
#[test]
fn waiting_commands_share_a_connection_failure() {
    let (log, _) = fake_state("fakedown-shared");
    let started = std::time::Instant::now();
    std::thread::scope(|s| {
        for _ in 0..5 {
            s.spawn(|| {
                let out = super::remote::run_ssh("fakedown-shared", "echo x", None).unwrap();
                assert!(super::remote::ssh_error("fakedown-shared", &out).unwrap().to_string().contains("timed out"));
            });
        }
    });
    assert_eq!(log_lines(&log).len(), 1, "one attempt for the five");
    assert!(started.elapsed() < std::time::Duration::from_millis(1500), "{:?}", started.elapsed());
    let _ = super::remote::run_ssh("fakedown-shared", "echo x", None).unwrap();
    assert_eq!(log_lines(&log).len(), 2, "a new command tries again");
}
