//! Commit history, refs and HEAD information.

use std::path::Path;

use serde::Serialize;

use super::runner;
use crate::error::AppResult;

/// Synthetic hash used for the "uncommitted changes" row at the top of the graph.
pub const WIP_HASH: &str = "WORKING_TREE";

const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub short: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer_name: String,
    pub commit_time: i64,
    pub subject: String,
    /// `None` for real commits, `wip` or `stash` for synthetic graph rows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

pub const LOG_FORMAT: &str = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%s%x1e";

pub fn parse_log(raw: &str) -> Vec<Commit> {
    raw.split(RECORD)
        .filter_map(|rec| {
            let rec = rec.trim_start_matches(['\n', '\r']);
            if rec.trim().is_empty() {
                return None;
            }
            let f: Vec<&str> = rec.split(FIELD).collect();
            if f.len() < 8 {
                return None;
            }
            let hash = f[0].trim().to_string();
            Some(Commit {
                short: hash.chars().take(7).collect(),
                parents: f[1].split_whitespace().map(String::from).collect(),
                author_name: f[2].to_string(),
                author_email: f[3].to_string(),
                author_time: f[4].trim().parse().unwrap_or(0),
                committer_name: f[5].to_string(),
                commit_time: f[6].trim().parse().unwrap_or(0),
                subject: f[7..].join("\u{1f}").trim_end().to_string(),
                kind: None,
                hash,
            })
        })
        .collect()
}

pub fn has_commits(repo: &Path) -> bool {
    runner::succeeds(repo, ["rev-parse", "--verify", "-q", "HEAD^{commit}"])
}

/// Load up to `limit` commits reachable from all branches, remote branches,
/// tags and HEAD, newest first (date order, parents after children).
#[allow(dead_code)] // single-call helper; the app reads these through `snapshot`
pub fn load_commits(repo: &Path, limit: usize) -> AppResult<Vec<Commit>> {
    let has_head = has_commits(repo);
    let any_refs =
        !runner::run(repo, ["for-each-ref", "--count=1", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"])?
            .trim()
            .is_empty();
    if !has_head && !any_refs {
        return Ok(vec![]);
    }
    let limit_arg = format!("--max-count={limit}");
    let format_arg = format!("--format={LOG_FORMAT}");
    let mut args = vec!["log", "--date-order", &limit_arg, &format_arg, "--branches", "--remotes", "--tags"];
    if has_head {
        args.push("HEAD");
    }
    args.push("--");
    let raw = runner::run(repo, args)?;
    Ok(parse_log(&raw))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefInfo {
    /// Full ref name, e.g. `refs/heads/main`.
    pub name: String,
    /// Display name, e.g. `main`, `origin/main`, `v1.0`.
    pub short: String,
    /// `local`, `remote` or `tag`.
    pub kind: String,
    /// Commit the ref points at (annotated tags are peeled).
    pub target: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub upstream_gone: bool,
    pub is_head: bool,
    pub remote: Option<String>,
    pub date: i64,
    pub subject: String,
}

pub const REF_FORMAT: &str =
    "%(refname)%1f%(objectname)%1f%(*objectname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)%1f%(committerdate:unix)%1f%(creatordate:unix)%1f%(contents:subject)";

fn parse_track(track: &str) -> (u32, u32, bool) {
    let mut ahead = 0;
    let mut behind = 0;
    let gone = track.trim() == "gone";
    for part in track.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.trim().parse().unwrap_or(0);
        }
    }
    (ahead, behind, gone)
}

pub fn parse_refs(raw: &str) -> Vec<RefInfo> {
    raw.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split(FIELD).collect();
            if f.len() < 9 {
                return None;
            }
            let name = f[0].to_string();
            let (kind, short, remote) = if let Some(s) = name.strip_prefix("refs/heads/") {
                ("local", s.to_string(), None)
            } else if let Some(s) = name.strip_prefix("refs/remotes/") {
                if s.ends_with("/HEAD") {
                    return None;
                }
                let remote = s.split('/').next().map(String::from);
                ("remote", s.to_string(), remote)
            } else {
                ("tag", name.strip_prefix("refs/tags/")?.to_string(), None)
            };
            let target = if !f[2].trim().is_empty() { f[2] } else { f[1] };
            let (ahead, behind, upstream_gone) = parse_track(f[4]);
            let date = f[6].trim().parse().or_else(|_| f[7].trim().parse()).unwrap_or(0);
            Some(RefInfo {
                short,
                kind: kind.to_string(),
                target: target.trim().to_string(),
                upstream: Some(f[3].trim().to_string()).filter(|s| !s.is_empty()),
                ahead,
                behind,
                upstream_gone,
                is_head: f[5].trim() == "*",
                remote,
                date,
                subject: f[8..].join("\u{1f}"),
                name,
            })
        })
        .collect()
}

#[allow(dead_code)] // single-call helper; the app reads these through `snapshot`
pub fn load_refs(repo: &Path) -> AppResult<Vec<RefInfo>> {
    let fmt = format!("--format={REF_FORMAT}");
    let raw = runner::run(repo, ["for-each-ref", fmt.as_str(), "refs/heads", "refs/remotes", "refs/tags"])?;
    Ok(parse_refs(&raw))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadInfo {
    /// Current branch name, `None` when detached or unborn.
    pub branch: Option<String>,
    /// Commit HEAD points at, `None` on an unborn branch.
    pub commit: Option<String>,
    pub detached: bool,
    pub unborn: bool,
}

#[allow(dead_code)] // single-call helper; the app reads these through `snapshot`
pub fn head_info(repo: &Path) -> AppResult<HeadInfo> {
    let branch =
        runner::run(repo, ["symbolic-ref", "-q", "--short", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let commit = runner::run(repo, ["rev-parse", "-q", "--verify", "HEAD^{commit}"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(HeadInfo { detached: branch.is_none() && commit.is_some(), unborn: commit.is_none(), branch, commit })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub hash: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer_name: String,
    pub committer_email: String,
    pub commit_time: i64,
    pub subject: String,
    pub body: String,
    pub files: Vec<ChangedFile>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub orig_path: Option<String>,
    /// One of A M D R C T U.
    pub status: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub binary: bool,
}

/// Parse `--name-status -z` output.
pub fn parse_name_status(raw: &str) -> Vec<ChangedFile> {
    let mut out = Vec::new();
    let mut it = raw.split('\0').filter(|s| !s.is_empty());
    while let Some(code) = it.next() {
        let code = code.trim_start_matches('\n');
        let letter = code.chars().next().unwrap_or('M');
        if letter == 'R' || letter == 'C' {
            let orig = it.next().unwrap_or_default().to_string();
            let path = it.next().unwrap_or_default().to_string();
            out.push(ChangedFile {
                path,
                orig_path: Some(orig),
                status: letter.to_string(),
                additions: None,
                deletions: None,
                binary: false,
            });
        } else {
            let path = it.next().unwrap_or_default().to_string();
            out.push(ChangedFile {
                path,
                orig_path: None,
                status: letter.to_string(),
                additions: None,
                deletions: None,
                binary: false,
            });
        }
    }
    out
}

/// Parse `--numstat -z` output into `(path, additions, deletions, binary)`.
pub fn parse_numstat(raw: &str) -> Vec<(String, Option<u32>, Option<u32>, bool)> {
    let mut out = Vec::new();
    let mut it = raw.split('\0');
    while let Some(entry) = it.next() {
        let entry = entry.trim_start_matches('\n');
        if entry.is_empty() {
            continue;
        }
        let mut parts = entry.splitn(3, '\t');
        let a = parts.next().unwrap_or("-");
        let d = parts.next().unwrap_or("-");
        let mut path = parts.next().unwrap_or("").to_string();
        if path.is_empty() {
            // rename: the next two fields are old and new paths
            let _old = it.next();
            path = it.next().unwrap_or_default().to_string();
        }
        let binary = a == "-" && d == "-";
        out.push((path, a.parse().ok(), d.parse().ok(), binary));
    }
    out
}

pub fn commit_detail(repo: &Path, sha: &str) -> AppResult<CommitDetail> {
    if sha.starts_with('-') {
        return Err(crate::error::AppError::invalid(crate::tr!("잘못된 리비전입니다", "Invalid revision")));
    }
    // One batch: a single SSH round trip for remote repositories.
    let o = runner::batch(
        repo,
        &[
            runner::Item::git(&[
                "show",
                "-s",
                "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%s%x1f%b",
                sha,
                "--",
            ]),
            runner::Item::git(&["show", "--format=", "--name-status", "-z", "-M", "--diff-merges=first-parent", sha, "--"]),
            runner::Item::git(&["show", "--format=", "--numstat", "-z", "-M", "--diff-merges=first-parent", sha, "--"]),
        ],
    )?;
    if !o[0].ok() {
        return Err(crate::error::AppError::Git(crate::trf!("커밋을 찾을 수 없습니다: {sha}", "Commit not found: {sha}")));
    }
    let raw = o[0].text();
    let f: Vec<&str> = raw.splitn(10, FIELD).collect();
    let get = |i: usize| f.get(i).copied().unwrap_or_default();
    let names = o[1].text();
    let nums = o[2].text();
    let mut files = parse_name_status(&names);
    let stats = parse_numstat(&nums);
    for file in files.iter_mut() {
        if let Some((_, a, d, bin)) = stats.iter().find(|(p, ..)| p == &file.path) {
            file.additions = *a;
            file.deletions = *d;
            file.binary = *bin;
        }
    }
    Ok(CommitDetail {
        hash: get(0).trim().to_string(),
        parents: get(1).split_whitespace().map(String::from).collect(),
        author_name: get(2).to_string(),
        author_email: get(3).to_string(),
        author_time: get(4).trim().parse().unwrap_or(0),
        committer_name: get(5).to_string(),
        committer_email: get(6).to_string(),
        commit_time: get(7).trim().parse().unwrap_or(0),
        subject: get(8).to_string(),
        body: get(9).trim().to_string(),
        files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_log_records() {
        let raw = "aaaaaaaaaa\u{1f}bbbb cccc\u{1f}Kim\u{1f}kim@x.org\u{1f}100\u{1f}Kim\u{1f}101\u{1f}Merge branch 'x'\u{1e}\n\
                   bbbb\u{1f}\u{1f}Lee\u{1f}lee@x.org\u{1f}50\u{1f}Lee\u{1f}51\u{1f}init\u{1e}\n";
        let commits = parse_log(raw);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].parents, vec!["bbbb", "cccc"]);
        assert_eq!(commits[0].short, "aaaaaaa");
        assert_eq!(commits[0].subject, "Merge branch 'x'");
        assert!(commits[1].parents.is_empty());
        assert_eq!(commits[1].author_time, 50);
    }

    #[test]
    fn parses_refs_and_tracking() {
        let raw = "refs/heads/main\u{1f}abc\u{1f}\u{1f}origin/main\u{1f}ahead 2, behind 1\u{1f}*\u{1f}10\u{1f}10\u{1f}subject\n\
                   refs/remotes/origin/HEAD\u{1f}abc\u{1f}\u{1f}\u{1f}\u{1f} \u{1f}10\u{1f}10\u{1f}s\n\
                   refs/remotes/origin/feature/x\u{1f}def\u{1f}\u{1f}\u{1f}\u{1f} \u{1f}9\u{1f}9\u{1f}s\n\
                   refs/tags/v1\u{1f}tagobj\u{1f}peeled\u{1f}\u{1f}\u{1f} \u{1f}\u{1f}8\u{1f}release";
        let refs = parse_refs(raw);
        assert_eq!(refs.len(), 3);
        assert_eq!(refs[0].short, "main");
        assert!(refs[0].is_head);
        assert_eq!((refs[0].ahead, refs[0].behind), (2, 1));
        assert_eq!(refs[1].short, "origin/feature/x");
        assert_eq!(refs[1].remote.as_deref(), Some("origin"));
        assert_eq!(refs[2].target, "peeled");
        assert_eq!(refs[2].date, 8);
    }

    #[test]
    fn parses_name_status_with_renames() {
        let raw = "M\0src/a.rs\0R087\0old.txt\0new.txt\0A\0b.txt\0";
        let files = parse_name_status(raw);
        assert_eq!(files.len(), 3);
        assert_eq!(files[1].status, "R");
        assert_eq!(files[1].orig_path.as_deref(), Some("old.txt"));
        assert_eq!(files[1].path, "new.txt");
    }

    #[test]
    fn parses_numstat_with_renames_and_binary() {
        let raw = "3\t1\tsrc/a.rs\0-\t-\timg.png\0".to_string() + "2\t0\t\0old.txt\0new.txt\0";
        let stats = parse_numstat(&raw);
        assert_eq!(stats[0], ("src/a.rs".into(), Some(3), Some(1), false));
        assert!(stats[1].3);
        assert_eq!(stats[2].0, "new.txt");
    }
}
