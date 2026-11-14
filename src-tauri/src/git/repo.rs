//! Repository discovery, worktrees, stashes, remotes and in-progress operations.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::remote;
use super::runner::{self, Item, ItemOut};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Identity used everywhere in the app: a local path or `ssh://host/path`.
    pub root: String,
    pub name: String,
    pub git_dir: String,
    pub common_dir: String,
    pub is_worktree: bool,
    /// SSH host alias for remote repositories.
    pub host: Option<String>,
    /// Path on the machine that holds the repository.
    pub path: String,
}

pub fn open(path: &Path) -> AppResult<RepoInfo> {
    let target = remote::parse(path);
    if target.is_none() && !path.exists() {
        return Err(AppError::invalid(crate::trf!("경로가 없습니다: {}", "Path does not exist: {}", path.display())));
    }
    let outs = runner::batch(
        path,
        &[
            Item::git(&["rev-parse", "--is-inside-work-tree"]),
            Item::git(&["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]),
        ],
    )?;
    if !outs[0].ok() {
        return Err(AppError::invalid(crate::trf!("Git 저장소가 아닙니다: {}", "Not a Git repository: {}", path.display())));
    }
    if outs[0].text().trim() != "true" {
        return Err(AppError::invalid(crate::tr!(
            "작업 트리가 없는 저장소(bare)는 아직 지원하지 않습니다.",
            "Repositories without a working tree (bare) are not supported yet."
        )));
    }
    let out = outs[1].text();
    let mut lines = out.lines();
    let top = lines.next().unwrap_or_default().trim().to_string();
    let git_dir = lines.next().unwrap_or_default().trim().to_string();
    let common = lines.next().unwrap_or_default().trim().to_string();
    let name = top.trim_end_matches('/').rsplit('/').next().filter(|n| !n.is_empty()).unwrap_or(&top).to_string();
    match target {
        Some(t) => {
            let common_dir =
                if common.starts_with('/') || common.chars().nth(1) == Some(':') { common } else { format!("{top}/{common}") };
            Ok(RepoInfo {
                is_worktree: git_dir.contains("/worktrees/"),
                root: remote::uri(&t.host, &top),
                name: format!("{name} @ {}", t.host),
                git_dir,
                common_dir,
                host: Some(t.host),
                path: top,
            })
        }
        None => {
            let common_dir = if Path::new(&common).is_absolute() {
                common
            } else {
                PathBuf::from(&top).join(common).to_string_lossy().to_string()
            };
            let common_dir = std::fs::canonicalize(&common_dir).map(|p| p.to_string_lossy().to_string()).unwrap_or(common_dir);
            let git_dir_c = std::fs::canonicalize(&git_dir).map(|p| p.to_string_lossy().to_string()).unwrap_or(git_dir.clone());
            Ok(RepoInfo {
                is_worktree: git_dir_c != common_dir,
                root: top.clone(),
                name,
                git_dir,
                common_dir,
                host: None,
                path: top,
            })
        }
    }
}

/// Which multi-step operation is in progress, if any.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    /// `merge`, `rebase`, `cherry-pick`, `revert` or `None`.
    pub operation: Option<String>,
    pub head_name: Option<String>,
    pub onto: Option<String>,
    pub step: Option<u32>,
    pub total: Option<u32>,
    /// Message git prepared for the pending commit (MERGE_MSG), without comment lines.
    pub message: Option<String>,
}

/// Batch items that describe the in-progress operation (all per-worktree git files).
pub fn state_items() -> Vec<Item> {
    vec![
        Item::GitDir("rebase-merge"),
        Item::GitDir("rebase-apply"),
        Item::GitFile("rebase-merge/head-name"),
        Item::GitFile("rebase-merge/onto"),
        Item::GitFile("rebase-merge/msgnum"),
        Item::GitFile("rebase-merge/end"),
        Item::GitFile("rebase-apply/head-name"),
        Item::GitFile("rebase-apply/onto"),
        Item::GitFile("rebase-apply/next"),
        Item::GitFile("rebase-apply/last"),
        Item::GitFile("MERGE_HEAD"),
        Item::GitFile("CHERRY_PICK_HEAD"),
        Item::GitFile("REVERT_HEAD"),
        Item::GitFile("MERGE_MSG"),
    ]
}

pub fn parse_state(o: &[ItemOut]) -> RepoState {
    let t = |i: usize| o.get(i).filter(|x| x.ok()).map(|x| x.text().trim().to_string()).filter(|s| !s.is_empty());
    let mut st = RepoState { operation: None, head_name: None, onto: None, step: None, total: None, message: None };
    for (dir_idx, base) in [(0usize, 2usize), (1, 6)] {
        if o.get(dir_idx).is_some_and(|x| x.ok()) {
            st.operation = Some("rebase".into());
            st.head_name = t(base).map(|s| s.trim_start_matches("refs/heads/").to_string());
            st.onto = t(base + 1);
            st.step = t(base + 2).and_then(|s| s.parse().ok());
            st.total = t(base + 3).and_then(|s| s.parse().ok());
            return st;
        }
    }
    for (idx, op) in [(10usize, "merge"), (11, "cherry-pick"), (12, "revert")] {
        if t(idx).is_some() {
            st.operation = Some(op.into());
            st.message = t(13)
                .map(|m| m.lines().filter(|l| !l.starts_with('#')).collect::<Vec<_>>().join("\n").trim().to_string())
                .filter(|m| !m.is_empty());
            break;
        }
    }
    st
}

#[allow(dead_code)] // single-call helper; the app reads state through `snapshot`
pub fn state(repo: &Path) -> AppResult<RepoState> {
    Ok(parse_state(&runner::batch(repo, &state_items())?))
}

/// Items whose output changes whenever anything visible in MobyD changes.
pub fn fingerprint_items() -> Vec<Item> {
    let mut v = vec![
        Item::git_env(&["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], &[("GIT_OPTIONAL_LOCKS", "0")]),
        Item::git(&["for-each-ref", "--format=%(refname)%(objectname)%(upstream:track)"]),
        Item::git(&["rev-parse", "-q", "--verify", "refs/stash"]),
        Item::git(&["worktree", "list", "--porcelain"]),
    ];
    v.extend(state_items());
    v
}

/// FNV-1a over the fingerprint outputs: collisions only delay a refresh.
pub fn hash_outputs(outs: &[ItemOut]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for o in outs {
        for b in o.out.iter().chain(o.code.to_le_bytes().iter()) {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    format!("{h:016x}")
}

/// A cheap fingerprint used to detect changes made outside MobyD (one round trip remotely).
pub fn fingerprint(repo: &Path) -> AppResult<String> {
    Ok(hash_outputs(&runner::batch(repo, &fingerprint_items())?))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    pub lock_reason: Option<String>,
    pub prunable: bool,
    pub is_main: bool,
    pub is_current: bool,
    /// What to pass to `repo_open` for this worktree (`ssh://…` for remote repos).
    pub open_path: String,
}

pub fn parse_worktrees(raw: &str, current_root: &str) -> Vec<Worktree> {
    let mut out: Vec<Worktree> = Vec::new();
    for block in raw.split("\n\n") {
        let mut wt = Worktree {
            path: String::new(),
            head: None,
            branch: None,
            detached: false,
            bare: false,
            locked: false,
            lock_reason: None,
            prunable: false,
            is_main: out.is_empty(),
            is_current: false,
            open_path: String::new(),
        };
        for line in block.lines() {
            let (key, value) = line.split_once(' ').unwrap_or((line, ""));
            match key {
                "worktree" => wt.path = value.to_string(),
                "HEAD" => wt.head = Some(value.to_string()),
                "branch" => wt.branch = Some(value.trim_start_matches("refs/heads/").to_string()),
                "detached" => wt.detached = true,
                "bare" => wt.bare = true,
                "locked" => {
                    wt.locked = true;
                    wt.lock_reason = Some(value.to_string()).filter(|s| !s.is_empty());
                }
                "prunable" => wt.prunable = true,
                _ => {}
            }
        }
        if wt.path.is_empty() {
            continue;
        }
        wt.is_current = same_path(&wt.path, current_root);
        wt.open_path = wt.path.clone();
        out.push(wt);
    }
    out
}

fn same_path(a: &str, b: &str) -> bool {
    if a.trim_end_matches('/') == b.trim_end_matches('/') {
        return true;
    }
    let ca = std::fs::canonicalize(a).unwrap_or_else(|_| PathBuf::from(a));
    let cb = std::fs::canonicalize(b).unwrap_or_else(|_| PathBuf::from(b));
    ca == cb
}

/// Point worktree `open_path`s of a remote repository at the same host.
pub fn localize_worktrees(repo: &Path, mut wts: Vec<Worktree>) -> Vec<Worktree> {
    if let Some(t) = remote::parse(repo) {
        for w in wts.iter_mut() {
            w.open_path = remote::uri(&t.host, &w.path);
        }
    }
    wts
}

pub fn worktrees(repo: &Path) -> AppResult<Vec<Worktree>> {
    let outs =
        runner::batch(repo, &[Item::git(&["worktree", "list", "--porcelain"]), Item::git(&["rev-parse", "--show-toplevel"])])?;
    Ok(localize_worktrees(repo, parse_worktrees(&outs[0].text(), outs[1].text().trim())))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    pub index: u32,
    pub name: String,
    pub hash: String,
    pub message: String,
    pub time: i64,
    /// Commit the stash was created on top of.
    pub base: Option<String>,
}

pub fn parse_stashes(raw: &str) -> Vec<Stash> {
    raw.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\u{1f}').collect();
            if f.len() < 5 {
                return None;
            }
            let index = f[0].trim_start_matches("stash@{").trim_end_matches('}').parse().ok()?;
            Some(Stash {
                index,
                name: f[0].to_string(),
                hash: f[1].to_string(),
                base: f[2].split_whitespace().next().map(String::from),
                time: f[3].parse().unwrap_or(0),
                message: f[4..].join(" "),
            })
        })
        .collect()
}

#[allow(dead_code)] // single-call helper; the app reads stashes through `snapshot`
pub fn stashes(repo: &Path) -> AppResult<Vec<Stash>> {
    let raw = runner::run(repo, ["stash", "list", super::snapshot::STASH_FORMAT])?;
    Ok(parse_stashes(&raw))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

pub fn parse_remotes(raw: &str) -> Vec<Remote> {
    let mut out: Vec<Remote> = Vec::new();
    for line in raw.lines() {
        let mut parts = line.split_whitespace();
        let (Some(name), Some(url), Some(kind)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let idx = match out.iter().position(|r| r.name == name) {
            Some(i) => i,
            None => {
                out.push(Remote { name: name.into(), fetch_url: String::new(), push_url: String::new() });
                out.len() - 1
            }
        };
        if kind == "(fetch)" {
            out[idx].fetch_url = url.into();
        } else {
            out[idx].push_url = url.into();
        }
    }
    out
}

pub fn remotes(repo: &Path) -> AppResult<Vec<Remote>> {
    Ok(parse_remotes(&runner::run(repo, ["remote", "-v"])?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_worktree_porcelain() {
        let raw = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n\
                   worktree /repo-wt/feature\nHEAD def\nbranch refs/heads/feature/x\nlocked on usb\n\n\
                   worktree /tmp/gone\nHEAD 123\ndetached\nprunable gitdir file points to non-existent location\n\n";
        let wts = parse_worktrees(raw, "/repo-wt/feature");
        assert_eq!(wts.len(), 3);
        assert!(wts[0].is_main);
        assert_eq!(wts[1].branch.as_deref(), Some("feature/x"));
        assert!(wts[1].locked);
        assert_eq!(wts[1].lock_reason.as_deref(), Some("on usb"));
        assert!(wts[1].is_current);
        assert!(wts[2].detached && wts[2].prunable);
    }

    #[test]
    fn parses_stash_list() {
        let raw = "stash@{0}\u{1f}aaa\u{1f}base1 idx1\u{1f}100\u{1f}WIP on main: 123 msg\nstash@{1}\u{1f}bbb\u{1f}base2\u{1f}90\u{1f}On dev: saved";
        let s = parse_stashes(raw);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].index, 0);
        assert_eq!(s[0].base.as_deref(), Some("base1"));
        assert_eq!(s[1].message, "On dev: saved");
    }

    #[test]
    fn parses_remotes() {
        let raw = "origin\tgit@github.com:me/repo.git (fetch)\norigin\tgit@github.com:me/repo.git (push)\nupstream\thttps://gitlab.com/g/r.git (fetch)\nupstream\thttps://gitlab.com/g/r.git (push)\n";
        let r = parse_remotes(raw);
        assert_eq!(r.len(), 2);
        assert_eq!(r[1].name, "upstream");
        assert_eq!(r[1].push_url, "https://gitlab.com/g/r.git");
    }
}
