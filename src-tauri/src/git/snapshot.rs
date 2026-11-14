//! Everything the main window needs, read in one batch (one SSH round trip
//! for remote repositories).

use std::path::Path;

use super::log::{self, Commit, HeadInfo, RefInfo};
use super::repo::{self, Remote, RepoState, Stash, Worktree};
use super::runner::{self, Item, HEAD_IF_VALID};
use super::status::{self, Status};
use crate::error::AppResult;

pub struct Snapshot {
    pub commits: Vec<Commit>,
    pub has_more: bool,
    pub head: HeadInfo,
    pub refs: Vec<RefInfo>,
    pub status: Status,
    pub stashes: Vec<Stash>,
    pub state: RepoState,
    pub worktrees: Vec<Worktree>,
    pub remotes: Vec<Remote>,
    pub fingerprint: String,
}

pub const STASH_FORMAT: &str = "--format=%gd%x1f%H%x1f%P%x1f%ct%x1f%gs";

pub fn load(repo: &Path, limit: usize) -> AppResult<Snapshot> {
    let mut items = repo::fingerprint_items();
    let fp_len = items.len();
    items.push(Item::git(&["rev-parse", "-q", "--verify", "HEAD^{commit}"]));
    items.push(Item::git(&["symbolic-ref", "-q", "--short", "HEAD"]));
    items.push(Item::git_owned(
        [
            "log".to_string(),
            "--date-order".into(),
            format!("--max-count={}", limit + 1),
            format!("--format={}", log::LOG_FORMAT),
            "--branches".into(),
            "--remotes".into(),
            "--tags".into(),
            HEAD_IF_VALID.into(),
            "--".into(),
        ]
        .to_vec(),
    ));
    items.push(Item::git_owned(vec![
        "for-each-ref".into(),
        format!("--format={}", log::REF_FORMAT),
        "refs/heads".into(),
        "refs/remotes".into(),
        "refs/tags".into(),
    ]));
    items.push(Item::git(&["stash", "list", STASH_FORMAT]));
    items.push(Item::git(&["remote", "-v"]));
    items.push(Item::git(&["rev-parse", "--show-toplevel"]));

    let o = runner::batch(repo, &items)?;
    let fingerprint = repo::hash_outputs(&o[..fp_len]);
    let state = repo::parse_state(&o[4..fp_len]);
    let b = fp_len;

    let head_commit = Some(o[b].text().trim().to_string()).filter(|s| o[b].ok() && !s.is_empty());
    let branch = Some(o[b + 1].text().trim().to_string()).filter(|s| o[b + 1].ok() && !s.is_empty());
    let head = HeadInfo {
        detached: branch.is_none() && head_commit.is_some(),
        unborn: head_commit.is_none(),
        branch,
        commit: head_commit,
    };

    let mut commits = if o[b + 2].ok() { log::parse_log(&o[b + 2].text()) } else { vec![] };
    let has_more = commits.len() > limit;
    commits.truncate(limit);

    let worktrees = repo::localize_worktrees(repo, repo::parse_worktrees(&o[3].text(), o[b + 6].text().trim()));
    Ok(Snapshot {
        commits,
        has_more,
        head,
        refs: log::parse_refs(&o[b + 3].text()),
        status: status::parse_status(&o[0].text()),
        stashes: repo::parse_stashes(&o[b + 4].text()),
        state,
        worktrees,
        remotes: repo::parse_remotes(&o[b + 5].text()),
        fingerprint,
    })
}
