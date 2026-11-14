//! Working tree status (`git status --porcelain=v2 -z`).

use std::path::Path;

use serde::Serialize;

use super::runner;
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub orig_path: Option<String>,
    /// A M D R C T U or `?` for untracked.
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub branch: Option<String>,
    pub oid: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<FileEntry>,
    pub unstaged: Vec<FileEntry>,
    pub conflicted: Vec<FileEntry>,
}

impl Status {
    pub fn is_dirty(&self) -> bool {
        !(self.staged.is_empty() && self.unstaged.is_empty() && self.conflicted.is_empty())
    }
}

fn entry(path: &str, orig: Option<&str>, code: char) -> FileEntry {
    FileEntry { path: path.to_string(), orig_path: orig.map(String::from), status: code.to_string() }
}

pub fn parse_status(raw: &str) -> Status {
    let mut st = Status::default();
    let mut tokens = raw.split('\0').peekable();
    while let Some(tok) = tokens.next() {
        if tok.is_empty() {
            continue;
        }
        if let Some(header) = tok.strip_prefix("# ") {
            if let Some(v) = header.strip_prefix("branch.head ") {
                if v != "(detached)" {
                    st.branch = Some(v.to_string());
                }
            } else if let Some(v) = header.strip_prefix("branch.oid ") {
                if v != "(initial)" {
                    st.oid = Some(v.to_string());
                }
            } else if let Some(v) = header.strip_prefix("branch.upstream ") {
                st.upstream = Some(v.to_string());
            } else if let Some(v) = header.strip_prefix("branch.ab ") {
                for part in v.split_whitespace() {
                    if let Some(n) = part.strip_prefix('+') {
                        st.ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = part.strip_prefix('-') {
                        st.behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        let kind = tok.chars().next().unwrap_or(' ');
        match kind {
            '1' => {
                let f: Vec<&str> = tok.splitn(9, ' ').collect();
                if f.len() == 9 {
                    push_xy(&mut st, f[1], f[8], None);
                }
            }
            '2' => {
                let f: Vec<&str> = tok.splitn(10, ' ').collect();
                let orig = tokens.next();
                if f.len() == 10 {
                    push_xy(&mut st, f[1], f[9], orig);
                }
            }
            'u' => {
                let f: Vec<&str> = tok.splitn(11, ' ').collect();
                if f.len() == 11 {
                    st.conflicted.push(entry(f[10], None, 'U'));
                }
            }
            '?' => {
                if let Some(path) = tok.get(2..) {
                    st.unstaged.push(entry(path, None, '?'));
                }
            }
            _ => {}
        }
    }
    st
}

fn push_xy(st: &mut Status, xy: &str, path: &str, orig: Option<&str>) {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    if x != '.' {
        st.staged.push(entry(path, orig, x));
    }
    if y != '.' {
        // A rename only exists in the index; the worktree side is a plain change.
        st.unstaged.push(entry(path, None, if y == 'R' || y == 'C' { 'M' } else { y }));
    }
}

pub const STATUS_ARGS: &[&str] = &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"];

pub fn status(repo: &Path) -> AppResult<Status> {
    let raw = runner::run_raw_env(repo, STATUS_ARGS, &[("GIT_OPTIONAL_LOCKS", "0")], None, &[])?;
    Ok(parse_status(&String::from_utf8_lossy(&raw)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let raw = "# branch.oid 1234\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +3 -1\0\
1 M. N... 100644 100644 100644 aaa bbb src/staged.rs\0\
1 .M N... 100644 100644 100644 aaa bbb src/unstaged file.rs\0\
1 MM N... 100644 100644 100644 aaa bbb both.rs\0\
2 R. N... 100644 100644 100644 aaa bbb R100 new name.rs\0old name.rs\0\
u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.rs\0\
? new/untracked.txt\0";
        let st = parse_status(raw);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!((st.ahead, st.behind), (3, 1));
        let staged: Vec<_> = st.staged.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(staged, vec!["src/staged.rs", "both.rs", "new name.rs"]);
        assert_eq!(st.staged[2].orig_path.as_deref(), Some("old name.rs"));
        let unstaged: Vec<_> = st.unstaged.iter().map(|e| (e.path.as_str(), e.status.as_str())).collect();
        assert_eq!(unstaged, vec![("src/unstaged file.rs", "M"), ("both.rs", "M"), ("new/untracked.txt", "?")]);
        assert_eq!(st.conflicted[0].path, "conflict.rs");
        assert!(st.is_dirty());
    }

    #[test]
    fn detached_and_initial() {
        let st = parse_status("# branch.oid (initial)\0# branch.head (detached)\0");
        assert!(st.branch.is_none());
        assert!(st.oid.is_none());
        assert!(!st.is_dirty());
    }
}
