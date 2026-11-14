//! Mutating git operations and diff retrieval.

use std::path::Path;

use serde::Deserialize;

use super::{remote, runner};
use crate::error::{AppError, AppResult};

const MAX_DIFF_BYTES: usize = 4 * 1024 * 1024;

fn guard_ref(name: &str) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty()
        || name.starts_with('-')
        || name.contains("..")
        || name.chars().any(|c| c.is_whitespace() || "~^:?*[\\".contains(c))
    {
        return Err(AppError::invalid(crate::trf!("사용할 수 없는 이름입니다: {name:?}", "Name not allowed: {name:?}")));
    }
    Ok(())
}

fn guard_rev(rev: &str) -> AppResult<()> {
    if rev.trim().is_empty() || rev.starts_with('-') {
        return Err(AppError::invalid(crate::trf!("잘못된 리비전입니다: {rev:?}", "Invalid revision: {rev:?}")));
    }
    Ok(())
}

// ----- diffs ---------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRequest {
    /// `commit`, `staged`, `unstaged` or `untracked`.
    pub kind: String,
    pub path: String,
    pub orig_path: Option<String>,
    pub sha: Option<String>,
    #[serde(default)]
    pub context: Option<u32>,
    #[serde(default)]
    pub ignore_whitespace: bool,
}

pub fn diff(repo: &Path, req: &DiffRequest) -> AppResult<String> {
    let ctx = format!("-U{}", req.context.unwrap_or(3));
    let mut args: Vec<String> = Vec::new();
    let mut ok_codes: Vec<i32> = vec![];
    match req.kind.as_str() {
        "commit" => {
            let sha = req
                .sha
                .clone()
                .ok_or_else(|| AppError::invalid(crate::tr!("커밋이 지정되지 않았습니다", "No commit specified")))?;
            guard_rev(&sha)?;
            args.extend(["show", "--format=", "-M", "--diff-merges=first-parent", "--no-ext-diff"].map(String::from));
            args.push(ctx);
            if req.ignore_whitespace {
                args.push("-w".into());
            }
            args.push(sha);
        }
        "staged" | "unstaged" => {
            args.extend(["diff", "--no-ext-diff", "-M"].map(String::from));
            if req.kind == "staged" {
                args.push("--cached".into());
            }
            args.push(ctx);
            if req.ignore_whitespace {
                args.push("-w".into());
            }
        }
        "untracked" => {
            args.extend(["diff", "--no-ext-diff", "--no-index"].map(String::from));
            args.push(ctx);
            args.push("--".into());
            args.push("/dev/null".into());
            args.push(req.path.clone());
            ok_codes.push(1);
            let out = runner::run_raw(repo, &args, None, &ok_codes)?;
            return Ok(truncate(out));
        }
        other => return Err(AppError::invalid(crate::trf!("알 수 없는 diff 종류: {other}", "Unknown diff kind: {other}"))),
    }
    args.push("--".into());
    if let Some(orig) = &req.orig_path {
        args.push(orig.clone());
    }
    args.push(req.path.clone());
    let out = runner::run_raw(repo, &args, None, &ok_codes)?;
    Ok(truncate(out))
}

fn truncate(mut out: Vec<u8>) -> String {
    if out.len() > MAX_DIFF_BYTES {
        out.truncate(MAX_DIFF_BYTES);
        let mut s = String::from_utf8_lossy(&out).into_owned();
        s.push_str(crate::tr!(
            "\n\\ MobyD: diff가 너무 커서 일부만 표시합니다\n",
            "\n\\ MobyD: the diff is too large; showing only part of it\n"
        ));
        s
    } else {
        String::from_utf8_lossy(&out).into_owned()
    }
}

// ----- index / working tree ------------------------------------------------

fn with_paths<'a>(base: &[&'a str], paths: &'a [String]) -> Vec<&'a str> {
    let mut v: Vec<&str> = base.to_vec();
    v.push("--");
    v.extend(paths.iter().map(String::as_str));
    v
}

pub fn stage(repo: &Path, paths: &[String]) -> AppResult<()> {
    if paths.is_empty() {
        runner::run(repo, ["add", "-A"])?;
    } else {
        runner::run(repo, with_paths(&["add", "-A"], paths))?;
    }
    Ok(())
}

pub fn unstage(repo: &Path, paths: &[String]) -> AppResult<()> {
    let has_head = super::log::has_commits(repo);
    match (has_head, paths.is_empty()) {
        (true, true) => runner::run(repo, ["reset", "-q"]).map(|_| ()),
        (true, false) => runner::run(repo, with_paths(&["restore", "--staged"], paths)).map(|_| ()),
        (false, true) => runner::run(repo, ["rm", "-r", "-q", "--cached", "."]).map(|_| ()),
        (false, false) => runner::run(repo, with_paths(&["rm", "-r", "-q", "--cached"], paths)).map(|_| ()),
    }
}

/// Throw away unstaged changes of tracked files and delete untracked files.
pub fn discard(repo: &Path, tracked: &[String], untracked: &[String]) -> AppResult<()> {
    if !tracked.is_empty() {
        runner::run(repo, with_paths(&["checkout"], tracked))?;
    }
    if !untracked.is_empty() {
        runner::run(repo, with_paths(&["clean", "-f", "-q"], untracked))?;
    }
    Ok(())
}

/// Apply a patch to the index and/or working tree (hunk/line staging).
pub fn apply_patch(repo: &Path, patch: &str, cached: bool, reverse: bool) -> AppResult<()> {
    let mut args = vec!["apply", "--whitespace=nowarn", "--recount"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("-R");
    }
    args.push("-");
    runner::run_stdin(repo, args, patch.as_bytes())?;
    Ok(())
}

pub fn commit(repo: &Path, message: &str, amend: bool, allow_empty: bool) -> AppResult<String> {
    if message.trim().is_empty() {
        return Err(AppError::invalid(crate::tr!("커밋 메시지를 입력하세요", "Enter a commit message")));
    }
    let mut args = vec!["commit", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    if allow_empty {
        args.push("--allow-empty");
    }
    runner::run_stdin(repo, args, message.as_bytes())
}

pub fn last_commit_message(repo: &Path) -> AppResult<String> {
    Ok(runner::run(repo, ["log", "-1", "--format=%B"])?.trim_end().to_string())
}

// ----- branches ------------------------------------------------------------

pub fn checkout_branch(repo: &Path, name: &str) -> AppResult<String> {
    guard_ref(name)?;
    runner::run(repo, ["switch", name])
}

/// Check out a remote branch, creating (or reusing) a local tracking branch.
pub fn checkout_remote(repo: &Path, remote_ref: &str, local: Option<&str>) -> AppResult<String> {
    guard_ref(remote_ref)?;
    let local_name = match local {
        Some(l) => l.to_string(),
        None => remote_ref.split_once('/').map(|(_, b)| b.to_string()).unwrap_or_else(|| remote_ref.to_string()),
    };
    guard_ref(&local_name)?;
    let exists = runner::succeeds(repo, ["show-ref", "--verify", "-q", &format!("refs/heads/{local_name}")]);
    if exists {
        runner::run(repo, ["switch", &local_name])
    } else {
        runner::run(repo, ["switch", "-c", &local_name, "--track", remote_ref])
    }
}

pub fn checkout_detached(repo: &Path, rev: &str) -> AppResult<String> {
    guard_rev(rev)?;
    runner::run(repo, ["switch", "--detach", rev])
}

pub fn create_branch(repo: &Path, name: &str, start: Option<&str>, checkout: bool) -> AppResult<String> {
    guard_ref(name)?;
    if let Some(s) = start {
        guard_rev(s)?;
    }
    if checkout {
        let mut args = vec!["switch", "-c", name];
        if let Some(s) = start {
            args.push(s);
        }
        runner::run(repo, args)
    } else {
        let mut args = vec!["branch", name];
        if let Some(s) = start {
            args.push(s);
        }
        runner::run(repo, args)
    }
}

pub fn delete_branch(repo: &Path, name: &str, force: bool) -> AppResult<String> {
    guard_ref(name)?;
    runner::run(repo, ["branch", if force { "-D" } else { "-d" }, name])
}

pub fn delete_remote_branch(repo: &Path, remote: &str, branch: &str) -> AppResult<String> {
    guard_ref(remote)?;
    guard_ref(branch)?;
    runner::run(repo, ["push", remote, "--delete", branch])
}

pub fn rename_branch(repo: &Path, old: &str, new: &str) -> AppResult<String> {
    guard_ref(old)?;
    guard_ref(new)?;
    runner::run(repo, ["branch", "-m", old, new])
}

pub fn set_upstream(repo: &Path, branch: &str, upstream: &str) -> AppResult<String> {
    guard_ref(branch)?;
    guard_ref(upstream)?;
    runner::run(repo, ["branch", &format!("--set-upstream-to={upstream}"), branch])
}

/// Move a local branch (not the checked-out one) forward to its upstream
/// without switching to it. Refuses anything that is not a fast-forward.
pub fn fast_forward_branch(repo: &Path, branch: &str, upstream: &str) -> AppResult<String> {
    guard_ref(branch)?;
    guard_ref(upstream)?;
    let current = runner::run(repo, ["symbolic-ref", "-q", "--short", "HEAD"]).unwrap_or_default();
    if current.trim() == branch {
        return Err(AppError::invalid(crate::tr!("현재 브랜치는 Pull로 업데이트하세요", "Update the current branch with Pull")));
    }
    let spec = format!("refs/remotes/{upstream}:refs/heads/{branch}");
    let (ok, text) = runner::run_report(repo, ["fetch", ".", &spec])?;
    if ok {
        Ok(text)
    } else if text.contains("non-fast-forward") || text.contains("rejected") {
        Err(AppError::Git(crate::trf!(
            "'{branch}'에 원격에 없는 커밋이 있어 fast-forward할 수 없습니다. 체크아웃 후 병합하거나 리베이스하세요.", "'{branch}' has commits that are not on the remote, so it cannot be fast-forwarded. Check it out and merge or rebase."
        )))
    } else {
        Err(AppError::Git(text))
    }
}

// ----- history rewriting / integration -------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpOutcome {
    pub ok: bool,
    pub conflicts: bool,
    pub message: String,
}

fn outcome(repo: &Path, ok: bool, message: String) -> OpOutcome {
    let conflicts = !ok && super::status::status(repo).map(|s| !s.conflicted.is_empty()).unwrap_or(false);
    OpOutcome { ok, conflicts, message }
}

/// `mode`: `ff` (default), `no-ff`, `ff-only` or `squash`.
pub fn merge(repo: &Path, rev: &str, mode: &str, message: Option<&str>) -> AppResult<OpOutcome> {
    guard_rev(rev)?;
    let mut args: Vec<String> = vec!["merge".into()];
    match mode {
        "no-ff" => args.push("--no-ff".into()),
        "ff-only" => args.push("--ff-only".into()),
        "squash" => args.push("--squash".into()),
        _ => {}
    }
    match message {
        Some(m) if !m.trim().is_empty() && mode != "squash" => {
            args.push("-m".into());
            args.push(m.into());
        }
        _ if mode != "squash" => args.push("--no-edit".into()),
        _ => {}
    }
    args.push(rev.into());
    let (ok, text) = runner::run_report(repo, &args)?;
    Ok(outcome(repo, ok, text))
}

pub fn rebase(repo: &Path, onto: &str) -> AppResult<OpOutcome> {
    guard_rev(onto)?;
    let (ok, text) = runner::run_report(repo, ["rebase", onto])?;
    Ok(outcome(repo, ok, text))
}

pub fn cherry_pick(repo: &Path, sha: &str) -> AppResult<OpOutcome> {
    guard_rev(sha)?;
    let parents = runner::run(repo, ["rev-list", "--parents", "-n", "1", sha])?;
    let is_merge = parents.split_whitespace().count() > 2;
    let mut args = vec!["cherry-pick"];
    if is_merge {
        args.extend(["-m", "1"]);
    }
    args.push(sha);
    let (ok, text) = runner::run_report(repo, args)?;
    Ok(outcome(repo, ok, text))
}

pub fn revert(repo: &Path, sha: &str) -> AppResult<OpOutcome> {
    guard_rev(sha)?;
    let parents = runner::run(repo, ["rev-list", "--parents", "-n", "1", sha])?;
    let is_merge = parents.split_whitespace().count() > 2;
    let mut args = vec!["revert", "--no-edit"];
    if is_merge {
        args.extend(["-m", "1"]);
    }
    args.push(sha);
    let (ok, text) = runner::run_report(repo, args)?;
    Ok(outcome(repo, ok, text))
}

pub fn reset(repo: &Path, sha: &str, mode: &str) -> AppResult<String> {
    guard_rev(sha)?;
    let flag = match mode {
        "soft" => "--soft",
        "hard" => "--hard",
        _ => "--mixed",
    };
    runner::run(repo, ["reset", "-q", flag, sha])
}

/// Continue/abort/skip the operation in progress.
pub fn sequencer(repo: &Path, operation: &str, action: &str) -> AppResult<OpOutcome> {
    let op = match operation {
        "merge" | "rebase" | "cherry-pick" | "revert" => operation,
        _ => return Err(AppError::invalid(crate::tr!("진행 중인 작업이 없습니다", "No operation in progress"))),
    };
    let flag = match action {
        "continue" => "--continue",
        "abort" => "--abort",
        "skip" if op != "merge" => "--skip",
        _ => return Err(AppError::invalid(crate::tr!("지원하지 않는 동작입니다", "Unsupported action"))),
    };
    let args: Vec<&str> = if op == "merge" && action == "continue" { vec!["commit", "--no-edit"] } else { vec![op, flag] };
    let (ok, text) = runner::run_report(repo, args)?;
    Ok(outcome(repo, ok, text))
}

/// Resolve a conflicted file by taking one side completely, then stage it.
pub fn resolve_conflict(repo: &Path, path: &str, side: &str) -> AppResult<()> {
    let flag = match side {
        "ours" => "--ours",
        "theirs" => "--theirs",
        _ => return Err(AppError::invalid(crate::tr!("ours 또는 theirs를 선택하세요", "Choose ours or theirs"))),
    };
    runner::run(repo, ["checkout", flag, "--", path])?;
    runner::run(repo, ["add", "--", path])?;
    Ok(())
}

// ----- tags ----------------------------------------------------------------

pub fn create_tag(repo: &Path, name: &str, rev: &str, message: Option<&str>) -> AppResult<String> {
    guard_ref(name)?;
    guard_rev(rev)?;
    match message.filter(|m| !m.trim().is_empty()) {
        Some(m) => runner::run(repo, ["tag", "-a", name, "-m", m, rev]),
        None => runner::run(repo, ["tag", name, rev]),
    }
}

pub fn delete_tag(repo: &Path, name: &str) -> AppResult<String> {
    guard_ref(name)?;
    runner::run(repo, ["tag", "-d", name])
}

pub fn push_tag(repo: &Path, remote: &str, name: &str) -> AppResult<String> {
    guard_ref(remote)?;
    guard_ref(name)?;
    let (ok, text) = runner::run_report(repo, ["push", remote, &format!("refs/tags/{name}")])?;
    if ok {
        Ok(text)
    } else {
        Err(AppError::Git(text))
    }
}

// ----- remotes / network ---------------------------------------------------

fn env_refs(env: &[(String, String)]) -> Vec<(&str, &str)> {
    env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
}

pub fn fetch(repo: &Path, remote: Option<&str>, prune: bool, env: &[(String, String)]) -> AppResult<String> {
    let mut args = vec!["fetch", "--tags"];
    if prune {
        args.push("--prune");
    }
    match remote {
        Some(r) => {
            guard_ref(r)?;
            args.push(r);
        }
        None => args.push("--all"),
    }
    let (ok, text) = runner::run_report_env(repo, args, &env_refs(env), None)?;
    if ok {
        Ok(text)
    } else {
        Err(AppError::Git(text))
    }
}

/// `mode`: `ff-only`, `merge` or `rebase`.
pub fn pull(repo: &Path, mode: &str, env: &[(String, String)]) -> AppResult<OpOutcome> {
    let flag = match mode {
        "rebase" => "--rebase",
        "merge" => "--no-rebase",
        _ => "--ff-only",
    };
    let (ok, text) = runner::run_report_env(repo, ["pull", flag], &env_refs(env), None)?;
    Ok(outcome(repo, ok, text))
}

pub fn push(
    repo: &Path,
    remote: Option<&str>,
    branch: Option<&str>,
    set_upstream: bool,
    force: bool,
    env: &[(String, String)],
) -> AppResult<String> {
    let mut args: Vec<String> = vec!["push".into()];
    if force {
        args.push("--force-with-lease".into());
    }
    if set_upstream {
        args.push("--set-upstream".into());
    }
    if let Some(r) = remote {
        guard_ref(r)?;
        args.push(r.into());
        if let Some(b) = branch {
            guard_ref(b)?;
            args.push(format!("HEAD:refs/heads/{b}"));
        }
    }
    let (ok, text) = runner::run_report_env(repo, &args, &env_refs(env), None)?;
    if ok {
        Ok(text)
    } else {
        Err(AppError::Git(text))
    }
}

pub fn add_remote(repo: &Path, name: &str, url: &str) -> AppResult<String> {
    guard_ref(name)?;
    if url.trim().is_empty() || url.starts_with('-') {
        return Err(AppError::invalid(crate::tr!("원격 URL이 올바르지 않습니다", "Invalid remote URL")));
    }
    runner::run(repo, ["remote", "add", name, url])
}

pub fn remove_remote(repo: &Path, name: &str) -> AppResult<String> {
    guard_ref(name)?;
    runner::run(repo, ["remote", "remove", name])
}

/// Fetch a pull/merge request head into a local branch and switch to it.
pub fn checkout_review_ref(repo: &Path, remote: &str, refspec_src: &str, local: &str) -> AppResult<String> {
    guard_ref(remote)?;
    guard_ref(local)?;
    let exists = runner::succeeds(repo, ["show-ref", "--verify", "-q", &format!("refs/heads/{local}")]);
    let current = runner::run(repo, ["symbolic-ref", "-q", "--short", "HEAD"]).unwrap_or_default();
    if exists && current.trim() == local {
        let (ok, text) = runner::run_report(repo, ["pull", "--ff-only", remote, refspec_src])?;
        return if ok { Ok(text) } else { Err(AppError::Git(text)) };
    }
    let spec = format!("+{refspec_src}:refs/heads/{local}");
    let (ok, text) = runner::run_report(repo, ["fetch", remote, &spec])?;
    if !ok {
        return Err(AppError::Git(text));
    }
    runner::run(repo, ["switch", local])
}

// ----- stash ---------------------------------------------------------------

pub fn stash_save(repo: &Path, message: Option<&str>, include_untracked: bool, staged_only: bool) -> AppResult<String> {
    let mut args = vec!["stash", "push"];
    if include_untracked && !staged_only {
        args.push("--include-untracked");
    }
    if staged_only {
        args.push("--staged");
    }
    if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
        args.push("-m");
        args.push(m);
    }
    runner::run(repo, args)
}

pub fn stash_action(repo: &Path, action: &str, index: u32) -> AppResult<OpOutcome> {
    let action = match action {
        "apply" | "pop" | "drop" => action,
        _ => return Err(AppError::invalid(crate::tr!("지원하지 않는 stash 동작", "Unsupported stash action"))),
    };
    let name = format!("stash@{{{index}}}");
    let (ok, text) = runner::run_report(repo, ["stash", action, &name])?;
    Ok(outcome(repo, ok, text))
}

// ----- worktrees -----------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAdd {
    pub path: String,
    /// Existing branch to check out, or the name for `new_branch`.
    pub branch: Option<String>,
    #[serde(default)]
    pub new_branch: bool,
    /// Start point for a new branch or a detached worktree.
    pub start: Option<String>,
    #[serde(default)]
    pub detach: bool,
}

pub fn worktree_add(repo: &Path, req: &WorktreeAdd) -> AppResult<String> {
    if req.path.trim().is_empty() {
        return Err(AppError::invalid(crate::tr!("워크트리 경로를 입력하세요", "Enter a worktree path")));
    }
    let target = Path::new(&req.path);
    if !runner::is_remote(repo) && target.exists() && std::fs::read_dir(target).map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(AppError::invalid(crate::trf!(
            "폴더가 이미 있고 비어 있지 않습니다: {}",
            "The folder already exists and is not empty: {}",
            req.path
        )));
    }
    if req.new_branch {
        if let Some(b) = &req.branch {
            if runner::succeeds(repo, ["show-ref", "--verify", "-q", &format!("refs/heads/{b}")]) {
                return Err(AppError::invalid(crate::trf!(
                    "브랜치 '{b}'가 이미 있습니다. '기존 브랜치 체크아웃'을 선택하세요.",
                    "Branch '{b}' already exists. Choose 'Check out existing branch'."
                )));
            }
        }
    }
    let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
    if req.detach {
        args.push("--detach".into());
        args.push(req.path.clone());
        if let Some(s) = &req.start {
            guard_rev(s)?;
            args.push(s.clone());
        }
    } else if req.new_branch {
        let b = req
            .branch
            .clone()
            .ok_or_else(|| AppError::invalid(crate::tr!("새 브랜치 이름을 입력하세요", "Enter a new branch name")))?;
        guard_ref(&b)?;
        args.extend(["-b".into(), b, req.path.clone()]);
        if let Some(s) = &req.start {
            guard_rev(s)?;
            args.push(s.clone());
        }
    } else {
        let b = req.branch.clone().ok_or_else(|| AppError::invalid(crate::tr!("브랜치를 선택하세요", "Choose a branch")))?;
        guard_ref(&b)?;
        args.extend([req.path.clone(), b]);
    }
    let (ok, text) = runner::run_report(repo, &args)?;
    if ok {
        Ok(text)
    } else {
        Err(AppError::Git(text))
    }
}

pub fn worktree_remove(repo: &Path, path: &str, force: bool) -> AppResult<String> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path);
    runner::run(repo, args)
}

pub fn worktree_lock(repo: &Path, path: &str, lock: bool, reason: Option<&str>) -> AppResult<String> {
    if lock {
        match reason.filter(|r| !r.trim().is_empty()) {
            Some(r) => runner::run(repo, ["worktree", "lock", "--reason", r, path]),
            None => runner::run(repo, ["worktree", "lock", path]),
        }
    } else {
        runner::run(repo, ["worktree", "unlock", path])
    }
}

pub fn worktree_prune(repo: &Path) -> AppResult<String> {
    runner::run(repo, ["worktree", "prune", "-v"])
}

// ----- repository creation -------------------------------------------------

pub fn init(path: &Path) -> AppResult<String> {
    if let Some(t) = remote::parse(path) {
        let script = format!(
            "{}mkdir -p -- {p} && cd -- {p} && exec {} init -b main\n",
            remote::PRELUDE,
            remote::GIT_OPTS,
            p = remote::sh_quote(&t.path)
        );
        let out = remote::run_script(&t.host, &script, None)?;
        return if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(AppError::Git(String::from_utf8_lossy(&out.stderr).trim().to_string()))
        };
    }
    std::fs::create_dir_all(path)?;
    runner::run(path, ["init", "-b", "main"])
}

/// Clone `url` into `dest` (a local path or `ssh://host/path`). `auth_env`
/// carries per-URL HTTP headers for tokens (never written to git config).
pub fn clone(url: &str, dest: &Path, auth_env: &[(String, String)]) -> AppResult<String> {
    if url.trim().is_empty() || url.starts_with('-') {
        return Err(AppError::invalid(crate::tr!("저장소 URL이 올바르지 않습니다", "Invalid repository URL")));
    }
    if let Some(t) = remote::parse(dest) {
        let parent = t.path.rsplit_once('/').map(|(a, _)| a).filter(|a| !a.is_empty()).unwrap_or("/");
        let script = format!(
            "{}mkdir -p -- {parent} && cd -- {parent} && {} clone --progress -- {} {}\n",
            remote::PRELUDE,
            remote::GIT_OPTS,
            remote::sh_quote(url),
            remote::sh_quote(&t.path),
            parent = remote::sh_quote(parent)
        );
        let out = remote::run_script(&t.host, &script, None)?;
        let text = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return if out.status.success() { Ok(text) } else { Err(AppError::Git(text)) };
    }
    if dest.exists() && std::fs::read_dir(dest).map(|mut d| d.next().is_some()).unwrap_or(false) {
        return Err(AppError::invalid(crate::trf!(
            "대상 폴더가 비어 있지 않습니다: {}",
            "The destination folder is not empty: {}",
            dest.display()
        )));
    }
    let parent = dest
        .parent()
        .ok_or_else(|| AppError::invalid(crate::tr!("대상 경로가 올바르지 않습니다", "Invalid destination path")))?;
    std::fs::create_dir_all(parent)?;
    let dest_s = dest.to_string_lossy().to_string();
    let env: Vec<(&str, &str)> = auth_env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let (ok, text) = runner::run_report_env(parent, ["clone", "--progress", "--", url, &dest_s], &env, None)?;
    if ok {
        Ok(text)
    } else {
        Err(AppError::Git(text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_option_like_names() {
        assert!(guard_ref("--upload-pack=evil").is_err());
        assert!(guard_ref("feature/ok").is_ok());
        assert!(guard_ref("bad name").is_err());
        assert!(guard_ref("a..b").is_err());
        assert!(guard_rev("-x").is_err());
        assert!(guard_rev("HEAD~2").is_ok());
    }
}
