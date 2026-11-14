//! Interactive rebase and blame.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::log::{self, Commit};
use super::ops::OpOutcome;
use super::{remote, runner, status};
use crate::error::{AppError, AppResult};

// ----- interactive rebase ------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlan {
    /// Commits that would be replayed, oldest first.
    pub commits: Vec<Commit>,
    pub has_merges: bool,
    pub branch: Option<String>,
}

/// Commits between `base` (exclusive) and HEAD. `base == "--root"` rebases the whole history.
pub fn rebase_plan(repo: &Path, base: &str) -> AppResult<RebasePlan> {
    let range = if base == "--root" {
        "HEAD".to_string()
    } else {
        if base.starts_with('-') || base.trim().is_empty() {
            return Err(AppError::invalid(crate::tr!("잘못된 기준 커밋입니다", "Invalid base commit")));
        }
        format!("{base}..HEAD")
    };
    let fmt = format!("--format={}", log::LOG_FORMAT);
    let o = runner::batch(
        repo,
        &[
            runner::Item::git(&["log", "--reverse", "--topo-order", &fmt, &range, "--"]),
            runner::Item::git(&["symbolic-ref", "-q", "--short", "HEAD"]),
        ],
    )?;
    if !o[0].ok() {
        return Err(AppError::Git(crate::trf!(
            "커밋 목록을 읽을 수 없습니다: {range}",
            "Could not read the commit list: {range}"
        )));
    }
    let commits = log::parse_log(&o[0].text());
    Ok(RebasePlan {
        has_merges: commits.iter().any(|c| c.parents.len() > 1),
        commits,
        branch: Some(o[1].text().trim().to_string()).filter(|s| o[1].ok() && !s.is_empty()),
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep {
    /// `pick`, `reword`, `edit`, `squash`, `fixup` or `drop`.
    pub action: String,
    pub hash: String,
    /// New message for `reword`, or for the last `squash`/`fixup` of a group.
    pub message: Option<String>,
}

fn amend_exec(message: &str) -> String {
    // The message travels base64-encoded so the todo line stays a single safe line.
    format!(
        "exec printf %s {} | base64 -d | git commit --amend --allow-empty --cleanup=strip -F -",
        remote::base64(message.as_bytes())
    )
}

/// Turn the edited plan into a git-rebase todo list.
pub fn build_todo(steps: &[RebaseStep]) -> AppResult<String> {
    let mut out = String::new();
    let mut have_base = false;
    for s in steps {
        if s.hash.is_empty() || !s.hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(AppError::invalid(crate::trf!("잘못된 커밋: {:?}", "Invalid commit: {:?}", s.hash)));
        }
        let msg = s.message.as_deref().map(str::trim).filter(|m| !m.is_empty());
        match s.action.as_str() {
            "pick" | "edit" => {
                out.push_str(&format!("{} {}\n", s.action, s.hash));
                have_base = true;
            }
            "reword" => {
                out.push_str(&format!("pick {}\n", s.hash));
                if let Some(m) = msg {
                    out.push_str(&amend_exec(m));
                    out.push('\n');
                }
                have_base = true;
            }
            "squash" | "fixup" => {
                if !have_base {
                    return Err(AppError::invalid(crate::tr!(
                        "첫 커밋은 squash/fixup으로 합칠 대상이 없습니다. 맨 위 커밋을 pick으로 두세요.",
                        "The first commit has nothing to squash/fixup into. Keep the top commit as pick."
                    )));
                }
                out.push_str(&format!("{} {}\n", s.action, s.hash));
                if let Some(m) = msg {
                    out.push_str(&amend_exec(m));
                    out.push('\n');
                }
            }
            "drop" => out.push_str(&format!("drop {}\n", s.hash)),
            other => return Err(AppError::invalid(crate::trf!("알 수 없는 동작: {other}", "Unknown action: {other}"))),
        }
    }
    if !have_base && steps.iter().all(|s| s.action == "drop") && !steps.is_empty() {
        // dropping everything is legal; git needs at least one line
        out.push_str("noop\n");
    }
    Ok(out)
}

pub fn rebase_interactive(repo: &Path, base: &str, steps: &[RebaseStep]) -> AppResult<OpOutcome> {
    let todo = build_todo(steps)?;
    let mut args = vec!["rebase", "-i", "--autostash"];
    if base == "--root" {
        args.push("--root");
    } else {
        if base.starts_with('-') {
            return Err(AppError::invalid(crate::tr!("잘못된 기준 커밋입니다", "Invalid base commit")));
        }
        args.push(base);
    }
    // git hands the todo file path to the sequence editor; `cat >` fills it from our stdin.
    let (ok, text) =
        runner::run_report_env(repo, args, &[("GIT_SEQUENCE_EDITOR", "cat >"), ("GIT_EDITOR", "true")], Some(todo.as_bytes()))?;
    let conflicts = !ok && status::status(repo).map(|s| !s.conflicted.is_empty()).unwrap_or(false);
    Ok(OpOutcome { ok, conflicts, message: text })
}

// ----- blame -------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommit {
    pub hash: String,
    pub author: String,
    pub author_time: i64,
    pub summary: String,
    pub uncommitted: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line: u32,
    pub hash: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Blame {
    pub path: String,
    pub lines: Vec<BlameLine>,
    pub commits: HashMap<String, BlameCommit>,
}

pub fn parse_blame(path: &str, raw: &str) -> Blame {
    let mut lines = Vec::new();
    let mut commits: HashMap<String, BlameCommit> = HashMap::new();
    let mut current = String::new();
    let mut final_line: u32 = 0;
    for l in raw.lines() {
        if let Some(text) = l.strip_prefix('\t') {
            lines.push(BlameLine { line: final_line, hash: current.clone(), text: text.to_string() });
            continue;
        }
        let mut parts = l.split(' ');
        let first = parts.next().unwrap_or_default();
        if first.len() == 40 && first.chars().all(|c| c.is_ascii_hexdigit()) {
            current = first.to_string();
            final_line = parts.nth(1).and_then(|n| n.parse().ok()).unwrap_or(final_line + 1);
            commits.entry(current.clone()).or_insert_with(|| BlameCommit {
                hash: current.clone(),
                author: String::new(),
                author_time: 0,
                summary: String::new(),
                uncommitted: current.chars().all(|c| c == '0'),
            });
            continue;
        }
        let rest = l.split_once(' ').map(|(_, r)| r).unwrap_or_default();
        if let Some(c) = commits.get_mut(&current) {
            match first {
                "author" => c.author = rest.to_string(),
                "author-time" => c.author_time = rest.parse().unwrap_or(0),
                "summary" => c.summary = rest.to_string(),
                _ => {}
            }
        }
    }
    Blame { path: path.to_string(), lines, commits }
}

/// `rev == None` blames the working tree file (uncommitted lines included).
pub fn blame(repo: &Path, path: &str, rev: Option<&str>) -> AppResult<Blame> {
    let mut args = vec!["blame", "--porcelain", "-w"];
    if let Some(r) = rev {
        if r.starts_with('-') {
            return Err(AppError::invalid(crate::tr!("잘못된 리비전입니다", "Invalid revision")));
        }
        args.push(r);
    }
    args.push("--");
    args.push(path);
    let raw = runner::run(repo, args)?;
    Ok(parse_blame(path, &raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(action: &str, hash: &str, message: Option<&str>) -> RebaseStep {
        RebaseStep { action: action.into(), hash: hash.into(), message: message.map(String::from) }
    }

    #[test]
    fn builds_todo_lists() {
        let todo = build_todo(&[
            step("pick", "aaa1", None),
            step("reword", "bbb2", Some("New title\n\nbody")),
            step("squash", "ccc3", None),
            step("fixup", "ddd4", Some("Combined")),
            step("drop", "eee5", None),
            step("edit", "fff6", None),
        ])
        .unwrap();
        let lines: Vec<&str> = todo.lines().collect();
        assert_eq!(lines[0], "pick aaa1");
        assert_eq!(lines[1], "pick bbb2");
        assert!(
            lines[2].starts_with("exec printf %s ")
                && lines[2].ends_with("git commit --amend --allow-empty --cleanup=strip -F -")
        );
        assert_eq!(lines[3], "squash ccc3");
        assert_eq!(lines[4], "fixup ddd4");
        assert!(lines[5].starts_with("exec "));
        assert_eq!(lines[6], "drop eee5");
        assert_eq!(lines[7], "edit fff6");
    }

    #[test]
    fn rejects_bad_plans() {
        assert!(build_todo(&[step("squash", "aaa1", None)]).is_err());
        assert!(build_todo(&[step("pick", "not-a-sha; rm -rf /", None)]).is_err());
        assert!(build_todo(&[step("explode", "aaa1", None)]).is_err());
    }

    #[test]
    fn parses_porcelain_blame() {
        let sha = "1234567890123456789012345678901234567890";
        let zero = "0000000000000000000000000000000000000000";
        let raw = format!(
            "{sha} 1 1 2\nauthor Flipper\nauthor-time 100\nsummary Add pod\nfilename a.ts\n\tline one\n\
             {sha} 2 2\n\tline two\n{zero} 3 3 1\nauthor Not Committed Yet\nauthor-time 200\nsummary Version of a.ts from a.ts\n\tdirty\n"
        );
        let b = parse_blame("a.ts", &raw);
        assert_eq!(b.lines.len(), 3);
        assert_eq!(b.lines[1].line, 2);
        assert_eq!(b.lines[1].text, "line two");
        assert_eq!(b.commits[sha].author, "Flipper");
        assert_eq!(b.commits[sha].summary, "Add pod");
        assert!(b.commits[zero].uncommitted);
    }
}
