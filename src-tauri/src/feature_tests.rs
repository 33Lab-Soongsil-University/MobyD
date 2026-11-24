//! Feature tests: every git feature the app offers, run through the same
//! command functions the UI calls, against real throwaway repositories (and a
//! local bare repository standing in for the server). Undo/Redo is checked
//! after each kind of change it records.
//!
//! git runs with an isolated config (`GIT_CONFIG_GLOBAL`), so the developer's
//! own hooks, signing or default branch never change the outcome.

use super::*;
use std::path::Path;
use std::sync::Once;
use tauri::async_runtime::block_on;

fn isolate_git() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let dir = std::env::temp_dir().join("mobyd-feature-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("gitconfig");
        std::fs::write(
            &cfg,
            "[user]\n\tname = MobyD Test\n\temail = test@mobyd.invalid\n[init]\n\tdefaultBranch = main\n\
             [commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[advice]\n\tdetachedHead = false\n",
        )
        .unwrap();
        std::env::set_var("GIT_CONFIG_GLOBAL", &cfg);
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    });
}

struct Sandbox {
    dir: tempfile::TempDir,
}

impl Sandbox {
    fn new() -> Self {
        isolate_git();
        Sandbox { dir: tempfile::tempdir().unwrap() }
    }

    fn path(&self, name: &str) -> String {
        self.dir.path().join(name).to_string_lossy().into_owned()
    }

    /// A new repository with one commit on `main`.
    fn repo(&self, name: &str) -> String {
        let repo = self.path(name);
        std::fs::create_dir_all(&repo).unwrap();
        block_on(repo_init(repo.clone())).unwrap();
        commit_file(&repo, "README.md", "hello\n", "Initial commit");
        repo
    }

    fn state(&self) -> AppState {
        let cfg = self.dir.path().join("config");
        std::fs::create_dir_all(&cfg).unwrap();
        crate::build_state(&cfg).unwrap()
    }
}

fn git(repo: &str, args: &[&str]) -> String {
    let out = std::process::Command::new(runner::git_bin()).current_dir(repo).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn write(repo: &str, file: &str, content: &str) {
    let path = Path::new(repo).join(file);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).unwrap();
    }
    std::fs::write(path, content).unwrap();
}

fn read(repo: &str, file: &str) -> Option<String> {
    std::fs::read_to_string(Path::new(repo).join(file)).ok()
}

fn head(repo: &str) -> String {
    git(repo, &["rev-parse", "HEAD"])
}

fn branch(repo: &str) -> String {
    git(repo, &["branch", "--show-current"])
}

/// Write, stage and commit one file through the app's commands.
fn commit_file(repo: &str, file: &str, content: &str, message: &str) -> String {
    write(repo, file, content);
    block_on(stage_paths(repo.into(), vec![file.into()])).unwrap();
    block_on(commit_create(repo.into(), message.into(), false)).unwrap();
    head(repo)
}

fn status_of(repo: &str) -> Status {
    block_on(repo_status(repo.into())).unwrap()
}

fn paths(entries: &[crate::git::status::FileEntry]) -> Vec<&str> {
    entries.iter().map(|e| e.path.as_str()).collect()
}

fn undo_label(repo: &str) -> Option<String> {
    undo_state(repo.into()).unwrap().undo
}

// ----- working tree, commits, history ----------------------------------------

#[test]
fn stage_commit_amend_and_inspect_history() {
    let sb = Sandbox::new();
    let repo = sb.path("app");
    std::fs::create_dir_all(&repo).unwrap();
    block_on(repo_init(repo.clone())).unwrap();
    let info = block_on(repo_open_impl(&sb.state(), repo.clone())).unwrap();
    assert!(Path::new(&info.root).ends_with("app"));

    write(&repo, "notes.txt", "one\n");
    assert_eq!(paths(&status_of(&repo).unstaged), ["notes.txt"], "untracked files are listed");
    block_on(stage_paths(repo.clone(), vec!["notes.txt".into()])).unwrap();
    assert_eq!(paths(&status_of(&repo).staged), ["notes.txt"]);
    block_on(commit_create(repo.clone(), "Add notes".into(), false)).unwrap();
    assert!(!status_of(&repo).is_dirty());
    assert_eq!(block_on(commit_last_message(repo.clone())).unwrap().trim(), "Add notes");

    write(&repo, "notes.txt", "one\ntwo\n");
    let req = DiffRequest {
        kind: "unstaged".into(),
        path: "notes.txt".into(),
        orig_path: None,
        sha: None,
        context: None,
        ignore_whitespace: false,
    };
    assert!(block_on(file_diff(repo.clone(), req)).unwrap().contains("+two"));
    block_on(stage_paths(repo.clone(), vec!["notes.txt".into()])).unwrap();
    block_on(unstage_paths(repo.clone(), vec!["notes.txt".into()])).unwrap();
    assert_eq!(paths(&status_of(&repo).unstaged), ["notes.txt"], "unstage puts it back");

    block_on(stage_paths(repo.clone(), vec!["notes.txt".into()])).unwrap();
    block_on(commit_create(repo.clone(), "Add notes, two lines".into(), true)).unwrap();
    assert_eq!(git(&repo, &["rev-list", "--count", "HEAD"]), "1", "amend replaces the commit");
    assert_eq!(git(&repo, &["log", "-1", "--format=%s"]), "Add notes, two lines");

    let sha = commit_file(&repo, "src/main.rs", "fn main() {}\n", "Add main");
    let graph = block_on(repo_graph_impl(&sb.state(), repo.clone(), None, Some(true))).unwrap();
    let subjects: Vec<&str> = graph.commits.iter().filter(|c| c.kind.is_none()).map(|c| c.subject.as_str()).collect();
    assert_eq!(subjects, ["Add main", "Add notes, two lines"]);
    assert_eq!(graph.head.branch.as_deref(), Some("main"));
    assert_eq!(graph.rows.len(), graph.commits.len());

    let detail = block_on(commit_detail(repo.clone(), sha.clone())).unwrap();
    assert_eq!(detail.hash, sha);
    let commit_diff = DiffRequest {
        kind: "commit".into(),
        path: "src/main.rs".into(),
        orig_path: None,
        sha: Some(sha.clone()),
        context: None,
        ignore_whitespace: false,
    };
    assert!(block_on(file_diff(repo.clone(), commit_diff)).unwrap().contains("+fn main() {}"));
    assert_eq!(block_on(file_history(repo.clone(), "notes.txt".into(), None)).unwrap().len(), 1);
    let blame = block_on(file_blame(repo.clone(), "notes.txt".into(), None)).unwrap();
    assert_eq!(blame.lines.len(), 2);
    assert!(!block_on(repo_fingerprint(repo.clone())).unwrap().is_empty());
}

#[test]
fn apply_and_reverse_a_partial_patch() {
    let sb = Sandbox::new();
    let repo = sb.repo("app");
    write(&repo, "README.md", "hello\nworld\n");
    let patch = git(&repo, &["diff", "--", "README.md"]) + "\n";
    block_on(apply_patch(repo.clone(), patch.clone(), true, false)).unwrap();
    assert_eq!(paths(&status_of(&repo).staged), ["README.md"], "patch staged");
    block_on(apply_patch(repo.clone(), patch, true, true)).unwrap();
    assert!(status_of(&repo).staged.is_empty(), "reverse patch unstages it");
}

#[test]
fn discard_changes_and_undo_brings_them_back() {
    let sb = Sandbox::new();
    let repo = sb.repo("app");
    write(&repo, "README.md", "edited\n");
    write(&repo, "scratch.txt", "temp\n");
    block_on(discard_paths(repo.clone(), vec!["README.md".into()], vec!["scratch.txt".into()])).unwrap();
    assert_eq!(read(&repo, "README.md").as_deref(), Some("hello\n"));
    assert_eq!(read(&repo, "scratch.txt"), None);
    assert!(undo_label(&repo).is_some());
    block_on(undo(repo.clone())).unwrap();
    assert_eq!(read(&repo, "README.md").as_deref(), Some("edited\n"), "undo restores discarded edits");
}

#[test]
fn undo_and_redo_a_commit() {
    let sb = Sandbox::new();
    let repo = sb.repo("app");
    let first = head(&repo);
    let second = commit_file(&repo, "a.txt", "a\n", "Add a");
    assert!(undo_label(&repo).is_some());

    block_on(undo(repo.clone())).unwrap();
    assert_eq!(head(&repo), first);
    assert_eq!(paths(&status_of(&repo).staged), ["a.txt"], "undoing a commit keeps its changes staged");
    assert!(undo_state(repo.clone()).unwrap().redo.is_some());

    block_on(redo(repo.clone())).unwrap();
    assert_eq!(head(&repo), second);
    assert!(!status_of(&repo).is_dirty());
}

// ----- branches, tags -------------------------------------------------------------

#[test]
fn branches_tags_checkout_and_their_undo() {
    let sb = Sandbox::new();
    let repo = sb.repo("app");
    let base = head(&repo);

    block_on(branch_create(repo.clone(), "feature".into(), None, false)).unwrap();
    assert_eq!(branch(&repo), "main");
    block_on(branch_checkout(repo.clone(), "feature".into(), false, None)).unwrap();
    assert_eq!(branch(&repo), "feature");
    block_on(undo(repo.clone())).unwrap();
    assert_eq!(branch(&repo), "main", "undo a checkout");

    block_on(checkout_detached(repo.clone(), base.clone())).unwrap();
    assert_eq!(branch(&repo), "", "detached HEAD");
    block_on(branch_checkout(repo.clone(), "main".into(), false, None)).unwrap();

    block_on(branch_rename(repo.clone(), "feature".into(), "topic".into())).unwrap();
    assert!(git(&repo, &["branch", "--list", "topic"]).contains("topic"));
    block_on(branch_delete(repo.clone(), "topic".into(), false)).unwrap();
    assert!(git(&repo, &["branch", "--list", "topic"]).is_empty());
    block_on(undo(repo.clone())).unwrap();
    assert!(git(&repo, &["branch", "--list", "topic"]).contains("topic"), "undo a branch delete");

    block_on(tag_create(repo.clone(), "v1".into(), base.clone(), None)).unwrap();
    block_on(tag_create(repo.clone(), "v2".into(), base.clone(), Some("Second".into()))).unwrap();
    assert_eq!(git(&repo, &["cat-file", "-t", "v2"]), "tag", "a message makes an annotated tag");
    block_on(tag_delete(repo.clone(), "v1".into())).unwrap();
    assert_eq!(git(&repo, &["tag", "--list"]), "v2");
}

// ----- integrating changes --------------------------------------------------------

/// `main` and `feature` each gain a commit on a different file.
fn diverged(sb: &Sandbox) -> (String, String, String) {
    let repo = sb.repo("app");
    block_on(branch_create(repo.clone(), "feature".into(), None, true)).unwrap();
    let f = commit_file(&repo, "feature.txt", "f\n", "Feature work");
    block_on(branch_checkout(repo.clone(), "main".into(), false, None)).unwrap();
    let m = commit_file(&repo, "main.txt", "m\n", "Main work");
    (repo, m, f)
}

#[test]
fn merge_and_undo_merge() {
    let sb = Sandbox::new();
    let (repo, m, f) = diverged(&sb);
    let r = block_on(merge_ref(repo.clone(), "feature".into(), "no-ff".into(), None)).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(git(&repo, &["rev-list", "--parents", "-n", "1", "HEAD"]).split(' ').count(), 3);
    assert!(read(&repo, "feature.txt").is_some());
    block_on(undo(repo.clone())).unwrap();
    assert_eq!(head(&repo), m, "undo a merge");
    assert_eq!(read(&repo, "feature.txt"), None);

    let r = block_on(merge_ref(repo.clone(), "feature".into(), "squash".into(), None)).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(paths(&status_of(&repo).staged), ["feature.txt"], "squash merge stages without committing");
    let _ = f;
}

#[test]
fn rebase_cherry_pick_revert_and_reset() {
    let sb = Sandbox::new();
    let (repo, m, f) = diverged(&sb);

    block_on(branch_checkout(repo.clone(), "feature".into(), false, None)).unwrap();
    let r = block_on(rebase_onto(repo.clone(), "main".into())).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(git(&repo, &["rev-parse", "HEAD~1"]), m, "feature now sits on main");
    block_on(undo(repo.clone())).unwrap();
    assert_eq!(head(&repo), f, "undo a rebase");

    block_on(branch_checkout(repo.clone(), "main".into(), false, None)).unwrap();
    let r = block_on(cherry_pick(repo.clone(), f.clone())).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(read(&repo, "feature.txt").as_deref(), Some("f\n"));

    let picked = head(&repo);
    let r = block_on(revert_commit(repo.clone(), picked.clone())).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(read(&repo, "feature.txt"), None, "revert removes the picked file");

    block_on(reset_to(repo.clone(), m.clone(), "hard".into())).unwrap();
    assert_eq!(head(&repo), m);
    block_on(undo(repo.clone())).unwrap();
    assert_ne!(head(&repo), m, "undo a hard reset");

    // HEAD is the revert again; stepping back over it keeps its change staged.
    block_on(reset_to(repo.clone(), picked.clone(), "soft".into())).unwrap();
    assert_eq!(head(&repo), picked);
    assert_eq!(paths(&status_of(&repo).staged), ["feature.txt"], "soft reset keeps changes staged");
}

#[test]
fn conflicts_resolve_continue_and_abort() {
    let sb = Sandbox::new();
    let repo = sb.repo("app");
    block_on(branch_create(repo.clone(), "feature".into(), None, true)).unwrap();
    let theirs = commit_file(&repo, "README.md", "feature line\n", "Feature edit");
    block_on(branch_checkout(repo.clone(), "main".into(), false, None)).unwrap();
    let ours = commit_file(&repo, "README.md", "main line\n", "Main edit");

    let r = block_on(merge_ref(repo.clone(), "feature".into(), "".into(), None)).unwrap();
    assert!(!r.ok && r.conflicts, "merge stops on the conflict");
    assert_eq!(paths(&status_of(&repo).conflicted), ["README.md"]);
    block_on(conflict_resolve(repo.clone(), "README.md".into(), "theirs".into())).unwrap();
    let r = block_on(sequencer(repo.clone(), "merge".into(), "continue".into())).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(read(&repo, "README.md").as_deref(), Some("feature line\n"));

    block_on(reset_to(repo.clone(), ours.clone(), "hard".into())).unwrap();
    let r = block_on(cherry_pick(repo.clone(), theirs.clone())).unwrap();
    assert!(r.conflicts);
    let r = block_on(sequencer(repo.clone(), "cherry-pick".into(), "abort".into())).unwrap();
    assert!(r.ok, "{}", r.message);
    assert!(!status_of(&repo).is_dirty());

    block_on(branch_checkout(repo.clone(), "feature".into(), false, None)).unwrap();
    let r = block_on(rebase_onto(repo.clone(), "main".into())).unwrap();
    assert!(r.conflicts);
    block_on(conflict_resolve(repo.clone(), "README.md".into(), "ours".into())).unwrap();
    let r = block_on(sequencer(repo.clone(), "rebase".into(), "abort".into())).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(head(&repo), theirs, "abort restores the branch");
}

#[test]
fn interactive_rebase_reword_fixup_drop() {
    let sb = Sandbox::new();
    let repo = sb.repo("app");
    let base = head(&repo);
    let a = commit_file(&repo, "a.txt", "a\n", "Add a");
    let b = commit_file(&repo, "b.txt", "b\n", "Add b");
    let c = commit_file(&repo, "c.txt", "c\n", "Add c");

    let plan = block_on(rebase_plan(repo.clone(), base.clone())).unwrap();
    let hashes: Vec<&str> = plan.commits.iter().map(|c| c.hash.as_str()).collect();
    assert_eq!(hashes, [a.as_str(), b.as_str(), c.as_str()], "oldest first");

    let step = |action: &str, hash: &str, message: Option<&str>| history::RebaseStep {
        action: action.into(),
        hash: hash.into(),
        message: message.map(String::from),
    };
    let steps = vec![step("reword", &a, Some("Add a and b")), step("fixup", &b, None), step("drop", &c, None)];
    let r = block_on(rebase_interactive(repo.clone(), base.clone(), steps)).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(git(&repo, &["log", "--format=%s", &format!("{base}..HEAD")]), "Add a and b");
    assert!(read(&repo, "b.txt").is_some() && read(&repo, "c.txt").is_none());
    block_on(undo(repo.clone())).unwrap();
    assert_eq!(head(&repo), c, "undo an interactive rebase");
}

// ----- stashes, worktrees -----------------------------------------------------------

#[test]
fn stash_save_apply_pop_drop_and_undo_drop() {
    let sb = Sandbox::new();
    let repo = sb.repo("app");
    let stashes = || git(&repo, &["stash", "list"]).lines().count();

    write(&repo, "README.md", "changed\n");
    write(&repo, "new.txt", "new\n");
    block_on(stash_save(repo.clone(), Some("wip".into()), true, false)).unwrap();
    assert!(!status_of(&repo).is_dirty() && stashes() == 1);
    let graph = block_on(repo_graph_impl(&sb.state(), repo.clone(), None, Some(true))).unwrap();
    assert_eq!(graph.stashes.len(), 1);

    assert!(block_on(stash_action(repo.clone(), "apply".into(), 0)).unwrap().ok);
    assert_eq!(read(&repo, "new.txt").as_deref(), Some("new\n"));
    assert_eq!(stashes(), 1, "apply keeps the stash");
    git(&repo, &["reset", "-q", "--hard"]);
    git(&repo, &["clean", "-qfd"]);

    assert!(block_on(stash_action(repo.clone(), "pop".into(), 0)).unwrap().ok);
    assert_eq!(read(&repo, "README.md").as_deref(), Some("changed\n"));
    assert_eq!(stashes(), 0);

    block_on(stash_save(repo.clone(), None, true, false)).unwrap();
    assert!(block_on(stash_action(repo.clone(), "drop".into(), 0)).unwrap().ok);
    assert_eq!(stashes(), 0);
    block_on(undo(repo.clone())).unwrap();
    assert_eq!(stashes(), 1, "undo a stash drop");
}

#[test]
fn worktree_add_lock_remove_prune() {
    let sb = Sandbox::new();
    let repo = sb.repo("app");
    let wt = sb.path("app-wt");
    let req = WorktreeAdd { path: wt.clone(), branch: Some("side".into()), new_branch: true, start: None, detach: false };
    block_on(worktree_add(repo.clone(), req)).unwrap();
    assert_eq!(branch(&wt), "side");

    let find = |list: &[Worktree]| list.iter().find(|w| w.branch.as_deref() == Some("side")).cloned().unwrap();
    let list = block_on(worktree_list(repo.clone())).unwrap();
    assert_eq!(list.len(), 2);
    let side = find(&list);
    assert!(!side.is_main && !side.is_current);

    block_on(worktree_lock(repo.clone(), side.path.clone(), true, Some("busy".into()))).unwrap();
    let side = find(&block_on(worktree_list(repo.clone())).unwrap());
    assert!(side.locked);
    assert_eq!(side.lock_reason.as_deref(), Some("busy"));
    block_on(worktree_lock(repo.clone(), side.path.clone(), false, None)).unwrap();

    let graph = block_on(repo_graph_impl(&sb.state(), repo.clone(), None, None)).unwrap();
    assert_eq!(graph.worktrees.len(), 2, "the graph knows about other worktrees");

    block_on(worktree_remove(repo.clone(), side.path.clone(), false)).unwrap();
    assert!(!Path::new(&wt).exists());
    block_on(worktree_prune(repo.clone())).unwrap();
    assert_eq!(block_on(worktree_list(repo.clone())).unwrap().len(), 1);
}

// ----- remotes ------------------------------------------------------------------------

#[test]
fn push_clone_fetch_pull_and_remote_branches() {
    let sb = Sandbox::new();
    let state = sb.state();
    let server = sb.path("server.git");
    std::fs::create_dir_all(&server).unwrap();
    git(&server, &["init", "-q", "--bare", "-b", "main"]);

    let a = sb.repo("alice");
    block_on(remote_add(a.clone(), "origin".into(), server.clone())).unwrap();
    assert_eq!(block_on(remote_list(a.clone())).unwrap().len(), 1);
    block_on(remote_push_impl(&state, a.clone(), Some("origin".into()), Some("main".into()), true, false)).unwrap();
    assert_eq!(git(&a, &["rev-parse", "--abbrev-ref", "main@{upstream}"]), "origin/main");

    let b = sb.path("bob");
    block_on(repo_clone_impl(&state, server.clone(), b.clone())).unwrap();
    assert_eq!(head(&b), head(&a));
    let from_b = commit_file(&b, "bob.txt", "hi\n", "Bob's change");
    block_on(remote_push_impl(&state, b.clone(), None, None, false, false)).unwrap();

    block_on(remote_fetch_impl(&state, a.clone(), Some("origin".into()))).unwrap();
    assert_eq!(status_of(&a).behind, 1);
    let r = block_on(remote_pull_impl(&state, a.clone(), "ff-only".into())).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(head(&a), from_b);

    // Diverged: pull --rebase keeps history linear.
    commit_file(&b, "bob2.txt", "2\n", "Bob again");
    block_on(remote_push_impl(&state, b.clone(), None, None, false, false)).unwrap();
    commit_file(&a, "alice.txt", "a\n", "Alice's change");
    let r = block_on(remote_pull_impl(&state, a.clone(), "rebase".into())).unwrap();
    assert!(r.ok, "{}", r.message);
    assert_eq!(git(&a, &["rev-list", "--merges", "--count", "HEAD"]), "0");
    assert!(read(&a, "bob2.txt").is_some() && read(&a, "alice.txt").is_some());
    block_on(remote_push_impl(&state, a.clone(), None, None, false, false)).unwrap();

    // A branch that is not checked out is fast-forwarded to its remote.
    block_on(remote_fetch_impl(&state, b.clone(), None)).unwrap();
    block_on(branch_create(b.clone(), "release".into(), Some(from_b.clone()), false)).unwrap();
    block_on(branch_fast_forward(b.clone(), "release".into(), "origin/main".into())).unwrap();
    assert_eq!(git(&b, &["rev-parse", "release"]), git(&b, &["rev-parse", "origin/main"]));
    assert!(block_on(branch_fast_forward(b.clone(), "main".into(), "origin/main".into())).is_err(), "current branch uses Pull");

    // Remote branches: check one out as a tracking branch, then delete it on the server.
    block_on(branch_create(a.clone(), "topic".into(), None, false)).unwrap();
    block_on(branch_checkout(a.clone(), "topic".into(), false, None)).unwrap();
    block_on(remote_push_impl(&state, a.clone(), Some("origin".into()), Some("topic".into()), true, false)).unwrap();
    block_on(remote_fetch_impl(&state, b.clone(), None)).unwrap();
    block_on(branch_checkout(b.clone(), "origin/topic".into(), true, None)).unwrap();
    assert_eq!(branch(&b), "topic");
    block_on(branch_set_upstream(b.clone(), "topic".into(), "origin/main".into())).unwrap();
    assert_eq!(git(&b, &["rev-parse", "--abbrev-ref", "topic@{upstream}"]), "origin/main");
    block_on(branch_delete_remote(a.clone(), "origin".into(), "topic".into())).unwrap();
    assert!(git(&server, &["branch", "--list", "topic"]).is_empty());

    block_on(tag_create(a.clone(), "v1.0".into(), "HEAD".into(), Some("Release".into()))).unwrap();
    block_on(tag_push(a.clone(), "origin".into(), "v1.0".into())).unwrap();
    assert_eq!(git(&server, &["tag", "--list"]), "v1.0");

    let forge = block_on(forge_remotes_impl(&state, a.clone())).unwrap();
    assert_eq!(forge.len(), 1, "local-path remotes are listed without a hosting service");
    block_on(remote_remove(a.clone(), "origin".into())).unwrap();
    assert!(block_on(remote_list(a.clone())).unwrap().is_empty());
}

/// Fetch and clone hand git the token of the account that can see the
/// repository, even when another account on the same host was added first.
#[test]
fn fetch_and_clone_send_the_right_accounts_token() {
    use std::sync::{Arc, Mutex};
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let git_auth: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = git_auth.clone();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let auth = req.headers().iter().find(|h| h.field.equiv("Authorization")).map(|h| h.value.to_string());
            let url = req.url().to_string();
            let code = if url == "/repos/team/app" {
                if auth.as_deref() == Some("Bearer tok-member") {
                    200
                } else {
                    404
                }
            } else {
                if url.contains("/info/refs") {
                    seen.lock().unwrap().push(auth.unwrap_or_default());
                }
                404
            };
            let _ = req.respond(tiny_http::Response::from_string("{}").with_status_code(code));
        }
    });

    let sb = Sandbox::new();
    let state = sb.state();
    let host = format!("127.0.0.1:{port}");
    for (user, token) in [("outsider", "tok-outsider"), ("member", "tok-member")] {
        let id = format!("github:{host}:{user}");
        // Test tokens go to the file store only, never the login keychain.
        let fallback = sb.dir.path().join("config").join("secrets.json");
        let mut map: std::collections::BTreeMap<String, String> =
            std::fs::read_to_string(&fallback).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        map.insert(id.clone(), token.into());
        std::fs::write(&fallback, serde_json::to_vec(&map).unwrap()).unwrap();
        state.settings.lock().unwrap().accounts.push(forge::Account {
            id,
            kind: ForgeKind::Github,
            base_url: format!("http://{host}"),
            username: Some(user.into()),
            avatar_url: None,
            api_url: Some(format!("http://{host}")),
        });
    }
    let expected = format!("Basic {}", crate::git::remote::base64(b"x-access-token:tok-member"));
    let url = format!("http://{host}/team/app.git");

    let repo = sb.repo("app");
    block_on(remote_add(repo.clone(), "origin".into(), url.clone())).unwrap();
    assert!(block_on(remote_fetch_impl(&state, repo.clone(), Some("origin".into()))).is_err(), "the mock serves no repository");
    assert!(block_on(repo_clone_impl(&state, url, sb.path("clone"))).is_err());
    let sent = git_auth.lock().unwrap().clone();
    assert_eq!(sent.len(), 2, "fetch and clone each reached the server: {sent:?}");
    assert!(sent.iter().all(|a| a == &expected), "git sent {sent:?}");
}
