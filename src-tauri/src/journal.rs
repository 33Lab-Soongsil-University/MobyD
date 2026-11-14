//! Undo / Redo.
//!
//! Every undoable action records what it changed (HEAD, a ref, a stash) as a
//! before/after pair. Undo only applies when the repository still looks
//! exactly like the recorded "after" state, so work done elsewhere (terminal,
//! another tool) is never clobbered. The journal lives for the app session,
//! per repository.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::git::runner::{self, Item};

const ZERO: &str = "0000000000000000000000000000000000000000";

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Snap {
    pub head: Option<String>,
    pub branch: Option<String>,
}

pub fn snap(repo: &Path) -> AppResult<Snap> {
    // One git process: `<sha>` then `refs/heads/<branch>` (or `HEAD` when detached).
    if let Ok(out) = runner::run(repo, ["rev-parse", "HEAD", "--symbolic-full-name", "HEAD"]) {
        let mut lines = out.lines();
        let head = lines.next().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
        let branch = lines.next().and_then(|l| l.trim().strip_prefix("refs/heads/")).map(String::from);
        if head.is_some() {
            return Ok(Snap { head, branch });
        }
    }
    // Unborn branch: no commit yet.
    let o = runner::batch(repo, &[Item::git(&["symbolic-ref", "-q", "--short", "HEAD"])])?;
    Ok(Snap { head: None, branch: Some(o[0].text().trim().to_string()).filter(|s| o[0].ok() && !s.is_empty()) })
}

pub fn ref_value(repo: &Path, refname: &str) -> Option<String> {
    runner::run(repo, ["rev-parse", "-q", "--verify", refname]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// The current branch (or detached HEAD) moved; `soft` keeps the undone commit's changes staged.
    HeadMove {
        before: Snap,
        after: Snap,
        soft: bool,
    },
    /// Switched branches / detached HEAD.
    Checkout {
        before: Snap,
        after: Snap,
    },
    /// A ref was created, deleted or moved (`None` = absent).
    RefSet {
        refname: String,
        before: Option<String>,
        after: Option<String>,
    },
    Rename {
        old: String,
        new: String,
    },
    /// Discarded unstaged changes of tracked files, kept as a binary patch.
    Discard {
        patch: String,
    },
    StashSave {
        sha: String,
    },
    StashDrop {
        sha: String,
        message: String,
    },
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub label: String,
    pub actions: Vec<Action>,
    pub redoable: bool,
}

#[derive(Default)]
struct Stacks {
    undo: Vec<Entry>,
    redo: Vec<Entry>,
}

fn journal() -> &'static Mutex<HashMap<String, Stacks>> {
    static J: OnceLock<Mutex<HashMap<String, Stacks>>> = OnceLock::new();
    J.get_or_init(Default::default)
}

pub fn record(repo: &str, entry: Entry) {
    if entry.actions.is_empty() {
        return;
    }
    let mut j = journal().lock().unwrap();
    let s = j.entry(repo.to_string()).or_default();
    s.undo.push(entry);
    if s.undo.len() > 100 {
        s.undo.remove(0);
    }
    s.redo.clear();
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UndoState {
    pub undo: Option<String>,
    pub redo: Option<String>,
}

pub fn state(repo: &str) -> UndoState {
    let j = journal().lock().unwrap();
    match j.get(repo) {
        Some(s) => UndoState { undo: s.undo.last().map(|e| e.label.clone()), redo: s.redo.last().map(|e| e.label.clone()) },
        None => UndoState::default(),
    }
}

/// Describe a HEAD change between two snapshots.
pub fn head_action(before: &Snap, after: &Snap, soft: bool) -> Option<Action> {
    if before == after {
        return None;
    }
    if before.branch == after.branch {
        Some(Action::HeadMove { before: before.clone(), after: after.clone(), soft })
    } else {
        Some(Action::Checkout { before: before.clone(), after: after.clone() })
    }
}

fn mismatch() -> AppError {
    AppError::invalid(crate::tr!(
        "그 사이 저장소가 바뀌어(다른 도구나 터미널 작업) 이 작업을 되돌릴 수 없습니다.",
        "The repository changed in the meantime (another tool or a terminal), so this action can no longer be undone."
    ))
}

fn go_to(repo: &Path, s: &Snap) -> AppResult<()> {
    match (&s.branch, &s.head) {
        (Some(b), _) => runner::run(repo, ["switch", b.as_str()]).map(|_| ()),
        (None, Some(h)) => runner::run(repo, ["switch", "--detach", h.as_str()]).map(|_| ()),
        (None, None) => Err(mismatch()),
    }
}

fn move_head(repo: &Path, from: &Snap, to: &Snap, soft: bool) -> AppResult<()> {
    if snap(repo)? != *from {
        return Err(mismatch());
    }
    match &to.head {
        Some(h) => runner::run(repo, ["reset", "-q", if soft { "--soft" } else { "--keep" }, h.as_str()]).map(|_| ()),
        // Undoing the very first commit: drop the branch ref but keep the index.
        None => runner::run(repo, ["update-ref", "-d", "HEAD"]).map(|_| ()),
    }
}

fn set_ref(repo: &Path, refname: &str, expect: &Option<String>, to: &Option<String>) -> AppResult<()> {
    let cur = ref_value(repo, refname);
    if &cur != expect {
        return Err(mismatch());
    }
    let old = expect.clone().unwrap_or_else(|| ZERO.to_string());
    match to {
        Some(v) => runner::run(repo, ["update-ref", refname, v.as_str(), old.as_str()]).map(|_| ()),
        None => runner::run(repo, ["update-ref", "-d", refname, old.as_str()]).map(|_| ()),
    }
}

fn undo_action(repo: &Path, a: &Action) -> AppResult<()> {
    match a {
        Action::HeadMove { before, after, soft } => move_head(repo, after, before, *soft),
        Action::Checkout { before, after } => {
            if snap(repo)? != *after {
                return Err(mismatch());
            }
            go_to(repo, before)
        }
        Action::RefSet { refname, before, after } => set_ref(repo, refname, after, before),
        Action::Rename { old, new } => runner::run(repo, ["branch", "-m", new.as_str(), old.as_str()]).map(|_| ()),
        Action::Discard { patch } => {
            runner::run_stdin(repo, ["apply", "--whitespace=nowarn", "--binary", "-"], patch.as_bytes()).map(|_| ())
        }
        Action::StashSave { sha } => {
            if ref_value(repo, "refs/stash").as_deref() != Some(sha.as_str()) {
                return Err(mismatch());
            }
            runner::run(repo, ["stash", "pop"]).map(|_| ())
        }
        Action::StashDrop { sha, message } => {
            runner::run(repo, ["stash", "store", "-m", message.as_str(), sha.as_str()]).map(|_| ())
        }
    }
}

fn redo_action(repo: &Path, a: &Action) -> AppResult<()> {
    match a {
        Action::HeadMove { before, after, soft } => move_head(repo, before, after, *soft),
        Action::Checkout { before, after } => {
            if snap(repo)? != *before {
                return Err(mismatch());
            }
            go_to(repo, after)
        }
        Action::RefSet { refname, before, after } => set_ref(repo, refname, before, after),
        Action::Rename { old, new } => runner::run(repo, ["branch", "-m", old.as_str(), new.as_str()]).map(|_| ()),
        _ => Err(AppError::invalid(crate::tr!("이 작업은 다시 실행할 수 없습니다", "This action cannot be redone"))),
    }
}

pub fn undo(repo_key: &str, repo: &Path) -> AppResult<String> {
    let entry = {
        let mut j = journal().lock().unwrap();
        j.get_mut(repo_key)
            .and_then(|s| s.undo.pop())
            .ok_or_else(|| AppError::invalid(crate::tr!("되돌릴 작업이 없습니다", "Nothing to undo")))?
    };
    let mut done = 0;
    let result = (|| {
        for a in entry.actions.iter().rev() {
            undo_action(repo, a)?;
            done += 1;
        }
        Ok::<_, AppError>(())
    })();
    let mut j = journal().lock().unwrap();
    let s = j.entry(repo_key.to_string()).or_default();
    match result {
        Ok(()) => {
            let label = entry.label.clone();
            if entry.redoable {
                s.redo.push(entry);
            }
            Ok(label)
        }
        Err(e) => {
            if done == 0 {
                // nothing changed: drop the stale entry so the user is not stuck on it
                s.redo.clear();
            }
            Err(e)
        }
    }
}

pub fn redo(repo_key: &str, repo: &Path) -> AppResult<String> {
    let entry = {
        let mut j = journal().lock().unwrap();
        j.get_mut(repo_key)
            .and_then(|s| s.redo.pop())
            .ok_or_else(|| AppError::invalid(crate::tr!("다시 실행할 작업이 없습니다", "Nothing to redo")))?
    };
    for a in entry.actions.iter() {
        redo_action(repo, a)?;
    }
    let label = entry.label.clone();
    journal().lock().unwrap().entry(repo_key.to_string()).or_default().undo.push(entry);
    Ok(label)
}

#[cfg(test)]
pub fn clear(repo_key: &str) {
    journal().lock().unwrap().remove(repo_key);
}
