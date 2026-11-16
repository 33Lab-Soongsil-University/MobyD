//! Tauri command handlers. Git work runs on the blocking thread pool so the
//! UI thread never waits on a subprocess.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::forge::{self, Account, ForgeClient, ForgeKind, MergeRequestOptions, NewPullRequest, RemoteTarget};
use crate::git::log::{Commit, CommitDetail, HeadInfo, RefInfo, WIP_HASH};
use crate::git::ops::{self, DiffRequest, OpOutcome, WorktreeAdd};
use crate::git::repo::{self, RepoInfo, RepoState, Stash, Worktree};
use crate::git::status::Status;
use crate::git::{graph, history, log, runner, snapshot, status};
use crate::journal;
use crate::store::{self, Secrets, Settings};

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub settings_path: PathBuf,
    pub secrets: Secrets,
    pub http: reqwest::Client,
}

impl AppState {
    fn save(&self, settings: &Settings) -> AppResult<()> {
        settings.save(&self.settings_path)
    }
}

/// One lock per working tree: mutating git commands run one at a time so a
/// double click can never race on `index.lock`. Reads stay parallel.
fn repo_lock(repo: &str) -> std::sync::Arc<Mutex<()>> {
    static LOCKS: std::sync::OnceLock<Mutex<std::collections::HashMap<PathBuf, std::sync::Arc<Mutex<()>>>>> =
        std::sync::OnceLock::new();
    let key = std::fs::canonicalize(repo).unwrap_or_else(|_| PathBuf::from(repo));
    let mut map = LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    map.entry(key).or_default().clone()
}

async fn writing<T, F>(repo: String, f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    let lock = repo_lock(&repo);
    blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        // over SSH, a change is never re-sent after a connection that broke mid-command
        let _mutating = crate::git::remote::mutating();
        f()
    })
    .await
}

async fn blocking<T, F>(f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::invalid(crate::trf!("작업 실행 실패: {e}", "Task failed to run: {e}")))?
}

fn p(repo: &str) -> PathBuf {
    PathBuf::from(repo)
}

// ----- app / settings -------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    git_version: Option<String>,
    git_path: String,
    version: String,
    platform: String,
}

#[tauri::command]
pub async fn app_info() -> AppResult<AppInfo> {
    blocking(|| {
        Ok(AppInfo {
            git_version: runner::git_version(),
            git_path: runner::git_bin().display().to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            platform: std::env::consts::OS.to_string(),
        })
    })
    .await
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> AppResult<Settings> {
    settings_get_impl(&state)
}

pub fn settings_get_impl(state: &AppState) -> AppResult<Settings> {
    Ok(state.settings.lock().unwrap().clone())
}

#[tauri::command]
pub fn settings_save_tabs(state: State<'_, AppState>, tabs: Vec<String>, active: Option<String>) -> AppResult<()> {
    settings_save_tabs_impl(&state, tabs, active)
}

pub fn settings_save_tabs_impl(state: &AppState, tabs: Vec<String>, active: Option<String>) -> AppResult<()> {
    let mut s = state.settings.lock().unwrap();
    s.open_tabs = tabs;
    s.active_tab = active;
    state.save(&s)
}

#[tauri::command]
pub fn settings_save_prefs(state: State<'_, AppState>, prefs: serde_json::Value) -> AppResult<()> {
    settings_save_prefs_impl(&state, prefs)
}

pub fn settings_save_prefs_impl(state: &AppState, prefs: serde_json::Value) -> AppResult<()> {
    let mut s = state.settings.lock().unwrap();
    s.prefs = prefs;
    state.save(&s)
}

#[tauri::command]
pub fn recent_remove(state: State<'_, AppState>, path: String) -> AppResult<Settings> {
    recent_remove_impl(&state, path)
}

pub fn recent_remove_impl(state: &AppState, path: String) -> AppResult<Settings> {
    let mut s = state.settings.lock().unwrap();
    s.recent.retain(|r| r.path != path);
    state.save(&s)?;
    Ok(s.clone())
}

// ----- repositories -------------------------------------------------------

#[tauri::command]
pub async fn repo_open(state: State<'_, AppState>, path: String) -> AppResult<RepoInfo> {
    repo_open_impl(&state, path).await
}

pub async fn repo_open_impl(state: &AppState, path: String) -> AppResult<RepoInfo> {
    let info = blocking(move || repo::open(&p(&path))).await?;
    let mut s = state.settings.lock().unwrap();
    s.touch_recent(&info.root, &info.name);
    state.save(&s)?;
    Ok(info)
}

#[tauri::command]
pub async fn repo_init(path: String) -> AppResult<String> {
    blocking(move || ops::init(&p(&path))).await
}

#[tauri::command]
pub async fn repo_clone(state: State<'_, AppState>, url: String, dest: String) -> AppResult<String> {
    repo_clone_impl(&state, url, dest).await
}

pub async fn repo_clone_impl(state: &AppState, url: String, dest: String) -> AppResult<String> {
    // Tokens are only handed to the local git; a clone on an SSH host uses that host's credentials.
    let env = if runner::is_remote(&p(&dest)) { vec![] } else { auth_env(state, std::slice::from_ref(&url)) };
    blocking(move || ops::clone(&url, &p(&dest), &env)).await
}

/// Per-URL HTTP auth headers for HTTPS remotes that match a connected account.
/// Passed through `GIT_CONFIG_*` environment variables so tokens never land in
/// a config file or on the command line.
pub fn auth_env(state: &AppState, urls: &[String]) -> Vec<(String, String)> {
    let settings = state.settings.lock().unwrap().clone();
    let mut pairs: Vec<(String, String)> = Vec::new();
    for url in urls {
        let Some((scheme, rest)) = url.split_once("://") else { continue };
        if scheme != "https" && scheme != "http" {
            continue;
        }
        let host = rest.split('/').next().unwrap_or_default().rsplit('@').next().unwrap_or_default().to_ascii_lowercase();
        let Some(acc) = settings.accounts.iter().find(|a| a.host() == host) else { continue };
        let Some(token) = state.secrets.get(&acc.id) else { continue };
        let user = match acc.kind {
            ForgeKind::Github => "x-access-token".to_string(),
            ForgeKind::Gitlab => "oauth2".to_string(),
            ForgeKind::Gitea => acc.username.clone().unwrap_or_else(|| "token".into()),
        };
        let key = format!("http.{scheme}://{host}/.extraHeader");
        if pairs.iter().any(|(k, _)| k == &key) {
            continue;
        }
        let value = format!("Authorization: Basic {}", crate::git::remote::base64(format!("{user}:{token}").as_bytes()));
        pairs.push((key, value));
    }
    let mut env = vec![("GIT_CONFIG_COUNT".to_string(), pairs.len().to_string())];
    for (i, (k, v)) in pairs.into_iter().enumerate() {
        env.push((format!("GIT_CONFIG_KEY_{i}"), k));
        env.push((format!("GIT_CONFIG_VALUE_{i}"), v));
    }
    if env.len() == 1 {
        env.clear();
    }
    env
}

fn repo_auth_env(state: &AppState, repo: &str) -> Vec<(String, String)> {
    if runner::is_remote(&p(repo)) {
        return vec![];
    }
    let urls: Vec<String> = repo::remotes(&p(repo))
        .map(|rs| rs.into_iter().flat_map(|r| [r.fetch_url, r.push_url]).filter(|u| !u.is_empty()).collect())
        .unwrap_or_default();
    auth_env(state, &urls)
}

#[tauri::command]
pub async fn repo_fingerprint(repo: String) -> AppResult<String> {
    blocking(move || repo::fingerprint(&p(&repo))).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPayload {
    commits: Vec<Commit>,
    rows: Vec<graph::GraphRow>,
    max_lanes: u16,
    refs: Vec<RefInfo>,
    head: HeadInfo,
    status: Status,
    stashes: Vec<Stash>,
    state: RepoState,
    has_more: bool,
    worktrees: Vec<Worktree>,
    forge_remotes: Vec<ForgeRemote>,
    fingerprint: String,
    undo: journal::UndoState,
}

#[tauri::command]
pub async fn repo_graph(
    state: State<'_, AppState>,
    repo: String,
    limit: Option<usize>,
    show_stashes: Option<bool>,
) -> AppResult<GraphPayload> {
    repo_graph_impl(&state, repo, limit, show_stashes).await
}

/// Graph, refs, status, worktrees, remotes and a change fingerprint in one batch
/// (a single SSH round trip for remote repositories).
pub async fn repo_graph_impl(
    state: &AppState,
    repo: String,
    limit: Option<usize>,
    show_stashes: Option<bool>,
) -> AppResult<GraphPayload> {
    let settings = state.settings.lock().unwrap().clone();
    blocking(move || {
        let path = p(&repo);
        let limit = limit.unwrap_or(2000).clamp(50, 100_000);
        let snap = snapshot::load(&path, limit)?;
        let mut commits = snap.commits;
        if show_stashes.unwrap_or(true) {
            // Place each stash just above the commit it was made on.
            for st in snap.stashes.iter().rev() {
                let Some(base) = &st.base else { continue };
                if let Some(idx) = commits.iter().position(|c| &c.hash == base) {
                    commits.insert(
                        idx,
                        Commit {
                            hash: format!("stash@{{{}}}", st.index),
                            short: format!("stash@{{{}}}", st.index),
                            parents: vec![base.clone()],
                            author_name: String::new(),
                            author_email: String::new(),
                            author_time: st.time,
                            committer_name: String::new(),
                            commit_time: st.time,
                            subject: st.message.clone(),
                            kind: Some("stash".into()),
                        },
                    );
                }
            }
        }
        if snap.status.is_dirty() || snap.state.operation.is_some() {
            commits.insert(
                0,
                Commit {
                    hash: WIP_HASH.into(),
                    short: "WIP".into(),
                    parents: snap.head.commit.iter().cloned().collect(),
                    author_name: String::new(),
                    author_email: String::new(),
                    author_time: store::now(),
                    committer_name: String::new(),
                    commit_time: store::now(),
                    subject: String::new(),
                    kind: Some("wip".into()),
                },
            );
        }
        let layout = graph::layout(commits.iter().map(|c| (c.hash.as_str(), c.parents.as_slice())));
        let forge_remotes = snap.remotes.iter().map(|r| resolve_remote(&settings, r)).collect();
        Ok(GraphPayload {
            commits,
            rows: layout.rows,
            max_lanes: layout.max_lanes,
            refs: snap.refs,
            head: snap.head,
            status: snap.status,
            stashes: snap.stashes,
            state: snap.state,
            has_more: snap.has_more,
            worktrees: snap.worktrees,
            forge_remotes,
            fingerprint: snap.fingerprint,
            undo: journal::state(&repo),
        })
    })
    .await
}

#[tauri::command]
pub async fn repo_status(repo: String) -> AppResult<Status> {
    blocking(move || status::status(&p(&repo))).await
}

#[tauri::command]
pub async fn commit_detail(repo: String, sha: String) -> AppResult<CommitDetail> {
    blocking(move || log::commit_detail(&p(&repo), &sha)).await
}

#[tauri::command]
pub async fn file_diff(repo: String, request: DiffRequest) -> AppResult<String> {
    blocking(move || ops::diff(&p(&repo), &request)).await
}

#[tauri::command]
pub async fn file_history(repo: String, path: String, limit: Option<usize>) -> AppResult<Vec<Commit>> {
    blocking(move || {
        let fmt = format!("--format={}", log::LOG_FORMAT);
        let lim = format!("--max-count={}", limit.unwrap_or(200));
        let raw = runner::run(&p(&repo), ["log", "--follow", lim.as_str(), fmt.as_str(), "--", path.as_str()])?;
        Ok(log::parse_log(&raw))
    })
    .await
}

// ----- staging & committing ---------------------------------------------------

#[tauri::command]
pub async fn stage_paths(repo: String, paths: Vec<String>) -> AppResult<()> {
    writing(repo.clone(), move || ops::stage(&p(&repo), &paths)).await
}

#[tauri::command]
pub async fn unstage_paths(repo: String, paths: Vec<String>) -> AppResult<()> {
    writing(repo.clone(), move || ops::unstage(&p(&repo), &paths)).await
}

#[tauri::command]
pub async fn discard_paths(repo: String, tracked: Vec<String>, untracked: Vec<String>) -> AppResult<()> {
    writing(repo.clone(), move || {
        let path = p(&repo);
        // Keep the discarded edits as a patch so Undo can bring them back (untracked files cannot be).
        let patch = if tracked.is_empty() {
            String::new()
        } else {
            let mut args: Vec<&str> = vec!["diff", "--binary", "--no-ext-diff", "--"];
            args.extend(tracked.iter().map(String::as_str));
            runner::run(&path, args).unwrap_or_default()
        };
        ops::discard(&path, &tracked, &untracked)?;
        if !patch.trim().is_empty() {
            let n = tracked.len();
            journal::record(
                &repo,
                journal::Entry {
                    label: crate::trf!("변경 버리기 ({n}개 파일)", "Discard changes ({n} files)"),
                    actions: vec![journal::Action::Discard { patch }],
                    redoable: false,
                },
            );
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn apply_patch(repo: String, patch: String, cached: bool, reverse: bool) -> AppResult<()> {
    writing(repo.clone(), move || ops::apply_patch(&p(&repo), &patch, cached, reverse)).await
}

#[tauri::command]
pub async fn commit_create(repo: String, message: String, amend: bool) -> AppResult<String> {
    let label = if amend { crate::tr!("커밋 수정 (amend)", "Amend commit") } else { crate::tr!("커밋", "Commit") };
    head_journaled(repo, label.into(), true, |_| true, move |path| ops::commit(path, &message, amend, false)).await
}

#[tauri::command]
pub async fn commit_last_message(repo: String) -> AppResult<String> {
    blocking(move || ops::last_commit_message(&p(&repo))).await
}

// ----- branches, tags, history ---------------------------------------------

#[tauri::command]
pub async fn branch_checkout(repo: String, name: String, remote: bool, local_name: Option<String>) -> AppResult<String> {
    let local = if remote {
        local_name.clone().unwrap_or_else(|| name.split_once('/').map(|(_, b)| b.to_string()).unwrap_or_else(|| name.clone()))
    } else {
        name.clone()
    };
    refs_journaled(
        repo,
        crate::trf!("체크아웃 '{local}'", "Check out '{local}'"),
        vec![format!("refs/heads/{local}")],
        move |path| {
            if remote {
                ops::checkout_remote(path, &name, local_name.as_deref())
            } else {
                ops::checkout_branch(path, &name)
            }
        },
    )
    .await
}

#[tauri::command]
pub async fn checkout_detached(repo: String, rev: String) -> AppResult<String> {
    head_journaled(
        repo,
        crate::trf!("체크아웃 {}", "Check out {}", rev.chars().take(8).collect::<String>()),
        false,
        |_| true,
        move |path| ops::checkout_detached(path, &rev),
    )
    .await
}

#[tauri::command]
pub async fn branch_create(repo: String, name: String, start: Option<String>, checkout: bool) -> AppResult<String> {
    refs_journaled(
        repo,
        crate::trf!("브랜치 만들기 '{name}'", "Create branch '{name}'"),
        vec![format!("refs/heads/{name}")],
        move |path| ops::create_branch(path, &name, start.as_deref(), checkout),
    )
    .await
}

#[tauri::command]
pub async fn branch_delete(repo: String, name: String, force: bool) -> AppResult<String> {
    refs_journaled(
        repo,
        crate::trf!("브랜치 삭제 '{name}'", "Delete branch '{name}'"),
        vec![format!("refs/heads/{name}")],
        move |path| ops::delete_branch(path, &name, force),
    )
    .await
}

#[tauri::command]
pub async fn branch_delete_remote(repo: String, remote: String, branch: String) -> AppResult<String> {
    writing(repo.clone(), move || ops::delete_remote_branch(&p(&repo), &remote, &branch)).await
}

#[tauri::command]
pub async fn branch_rename(repo: String, old: String, new: String) -> AppResult<String> {
    writing(repo.clone(), move || {
        let r = ops::rename_branch(&p(&repo), &old, &new)?;
        journal::record(
            &repo,
            journal::Entry {
                label: crate::trf!("이름 변경 '{old}' → '{new}'", "Rename '{old}' → '{new}'"),
                actions: vec![journal::Action::Rename { old: old.clone(), new: new.clone() }],
                redoable: true,
            },
        );
        Ok(r)
    })
    .await
}

#[tauri::command]
pub async fn branch_set_upstream(repo: String, branch: String, upstream: String) -> AppResult<String> {
    writing(repo.clone(), move || ops::set_upstream(&p(&repo), &branch, &upstream)).await
}

#[tauri::command]
pub async fn merge_ref(repo: String, rev: String, mode: String, message: Option<String>) -> AppResult<OpOutcome> {
    head_journaled(
        repo,
        crate::trf!("병합 '{rev}'", "Merge '{rev}'"),
        false,
        |r: &OpOutcome| r.ok,
        move |path| ops::merge(path, &rev, &mode, message.as_deref()),
    )
    .await
}

#[tauri::command]
pub async fn rebase_onto(repo: String, onto: String) -> AppResult<OpOutcome> {
    head_journaled(
        repo,
        crate::trf!("리베이스 → '{onto}'", "Rebase → '{onto}'"),
        false,
        |r: &OpOutcome| r.ok,
        move |path| ops::rebase(path, &onto),
    )
    .await
}

#[tauri::command]
pub async fn cherry_pick(repo: String, sha: String) -> AppResult<OpOutcome> {
    let label = crate::trf!("체리픽 {}", "Cherry-pick {}", sha.chars().take(8).collect::<String>());
    head_journaled(repo, label, false, |r: &OpOutcome| r.ok, move |path| ops::cherry_pick(path, &sha)).await
}

#[tauri::command]
pub async fn revert_commit(repo: String, sha: String) -> AppResult<OpOutcome> {
    let label = crate::trf!("되돌리기 커밋 {}", "Revert commit {}", sha.chars().take(8).collect::<String>());
    head_journaled(repo, label, false, |r: &OpOutcome| r.ok, move |path| ops::revert(path, &sha)).await
}

#[tauri::command]
pub async fn reset_to(repo: String, sha: String, mode: String) -> AppResult<String> {
    let label = format!("reset ({mode}) → {}", sha.chars().take(8).collect::<String>());
    head_journaled(repo, label, mode == "soft", |_| true, move |path| ops::reset(path, &sha, &mode)).await
}

#[tauri::command]
pub async fn sequencer(repo: String, operation: String, action: String) -> AppResult<OpOutcome> {
    // Finishing a merge, cherry-pick or revert after resolving conflicts creates
    // one commit on the current branch: record it so Undo takes it back. (A
    // rebase continues from a detached mid-state, which Undo cannot restore.)
    if action == "continue" && operation != "rebase" {
        let label = match operation.as_str() {
            "merge" => crate::tr!("병합 완료", "Finish merge"),
            "cherry-pick" => crate::tr!("체리픽 완료", "Finish cherry-pick"),
            _ => crate::tr!("되돌리기 완료", "Finish revert"),
        };
        return head_journaled(
            repo,
            label.into(),
            false,
            |r: &OpOutcome| r.ok,
            move |path| ops::sequencer(path, &operation, &action),
        )
        .await;
    }
    writing(repo.clone(), move || ops::sequencer(&p(&repo), &operation, &action)).await
}

#[tauri::command]
pub async fn conflict_resolve(repo: String, path: String, side: String) -> AppResult<()> {
    writing(repo.clone(), move || ops::resolve_conflict(&p(&repo), &path, &side)).await
}

#[tauri::command]
pub async fn tag_create(repo: String, name: String, rev: String, message: Option<String>) -> AppResult<String> {
    refs_journaled(
        repo,
        crate::trf!("태그 만들기 '{name}'", "Create tag '{name}'"),
        vec![format!("refs/tags/{name}")],
        move |path| ops::create_tag(path, &name, &rev, message.as_deref()),
    )
    .await
}

#[tauri::command]
pub async fn tag_delete(repo: String, name: String) -> AppResult<String> {
    refs_journaled(
        repo,
        crate::trf!("태그 삭제 '{name}'", "Delete tag '{name}'"),
        vec![format!("refs/tags/{name}")],
        move |path| ops::delete_tag(path, &name),
    )
    .await
}

#[tauri::command]
pub async fn tag_push(repo: String, remote: String, name: String) -> AppResult<String> {
    writing(repo.clone(), move || ops::push_tag(&p(&repo), &remote, &name)).await
}

#[tauri::command]
pub async fn branch_fast_forward(repo: String, branch: String, upstream: String) -> AppResult<String> {
    refs_journaled(repo, format!("fast-forward '{branch}'"), vec![format!("refs/heads/{branch}")], move |path| {
        ops::fast_forward_branch(path, &branch, &upstream)
    })
    .await
}

/// Open the platform terminal in `path` (for `ssh://` repositories: a terminal logged into that host).
#[tauri::command]
pub async fn open_terminal(path: String) -> AppResult<()> {
    blocking(move || {
        if let Some(t) = crate::git::remote::parse(&p(&path)) {
            let line = crate::git::remote::terminal_command(&t.host, &t.path);
            if cfg!(target_os = "macos") {
                // A .command file opens in Terminal and runs, without needing Automation permission.
                let dir = std::env::temp_dir().join("mobyd-terminal");
                std::fs::create_dir_all(&dir)?;
                let safe: String = t.host.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
                let file = dir.join(format!("ssh-{safe}.command"));
                std::fs::write(&file, format!("#!/bin/sh\n{line}\n"))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700))?;
                }
                std::process::Command::new("open").args(["-a", "Terminal"]).arg(&file).spawn().map_err(|e| {
                    AppError::invalid(crate::trf!("터미널을 열 수 없습니다: {e}", "Could not open a terminal: {e}"))
                })?;
                return Ok(());
            }
            let spawned = if cfg!(windows) {
                std::process::Command::new("cmd").args(["/C", "start", "cmd", "/K", &line]).spawn().map(|_| ())
            } else {
                std::process::Command::new("x-terminal-emulator").args(["-e", "sh", "-c", &line]).spawn().map(|_| ())
            };
            return spawned
                .map_err(|e| AppError::invalid(crate::trf!("터미널을 열 수 없습니다: {e}", "Could not open a terminal: {e}")));
        }
        let dir = p(&path);
        if !dir.is_dir() {
            return Err(AppError::invalid(crate::tr!("폴더가 없습니다", "The folder does not exist")));
        }
        let spawned = if cfg!(target_os = "macos") {
            std::process::Command::new("open").args(["-a", "Terminal"]).arg(&dir).spawn().map(|_| ())
        } else if cfg!(windows) {
            std::process::Command::new("cmd").args(["/C", "start", "cmd", "/K", "cd", "/d"]).arg(&dir).spawn().map(|_| ())
        } else {
            ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]
                .iter()
                .find_map(|t| std::process::Command::new(t).current_dir(&dir).spawn().ok())
                .map(|_| ())
                .ok_or_else(|| std::io::Error::other("no terminal found"))
        };
        spawned.map_err(|e| AppError::invalid(crate::trf!("터미널을 열 수 없습니다: {e}", "Could not open a terminal: {e}")))
    })
    .await
}

// ----- undo journal --------------------------------------------------------------

/// Run a write that moves HEAD and record it for Undo when it succeeded.
async fn head_journaled<T, F, K>(repo: String, label: String, soft: bool, ok: K, f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&std::path::Path) -> AppResult<T> + Send + 'static,
    K: FnOnce(&T) -> bool + Send + 'static,
{
    writing(repo.clone(), move || {
        let path = p(&repo);
        let before = journal::snap(&path)?;
        let r = f(&path)?;
        if ok(&r) {
            if let Ok(after) = journal::snap(&path) {
                if let Some(a) = journal::head_action(&before, &after, soft) {
                    journal::record(&repo, journal::Entry { label, actions: vec![a], redoable: true });
                }
            }
        }
        Ok(r)
    })
    .await
}

/// Run a write that changes refs and record the ref changes for Undo.
async fn refs_journaled<T, F>(repo: String, label: String, refs: Vec<String>, f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&std::path::Path) -> AppResult<T> + Send + 'static,
{
    writing(repo.clone(), move || {
        let path = p(&repo);
        let before_head = journal::snap(&path)?;
        let before: Vec<Option<String>> = refs.iter().map(|r| journal::ref_value(&path, r)).collect();
        let r = f(&path)?;
        let mut actions = Vec::new();
        for (refname, old) in refs.iter().zip(before) {
            let new = journal::ref_value(&path, refname);
            if new != old {
                actions.push(journal::Action::RefSet { refname: refname.clone(), before: old, after: new });
            }
        }
        if let Ok(after_head) = journal::snap(&path) {
            if let Some(a) = journal::head_action(&before_head, &after_head, false) {
                actions.push(a);
            }
        }
        journal::record(&repo, journal::Entry { label, actions, redoable: true });
        Ok(r)
    })
    .await
}

#[tauri::command]
pub async fn undo(repo: String) -> AppResult<String> {
    writing(repo.clone(), move || journal::undo(&repo, &p(&repo))).await
}

#[tauri::command]
pub async fn redo(repo: String) -> AppResult<String> {
    writing(repo.clone(), move || journal::redo(&repo, &p(&repo))).await
}

#[tauri::command]
pub fn undo_state(repo: String) -> AppResult<journal::UndoState> {
    Ok(journal::state(&repo))
}

// ----- interactive rebase & blame ------------------------------------------------

#[tauri::command]
pub async fn rebase_plan(repo: String, base: String) -> AppResult<history::RebasePlan> {
    blocking(move || history::rebase_plan(&p(&repo), &base)).await
}

#[tauri::command]
pub async fn rebase_interactive(repo: String, base: String, steps: Vec<history::RebaseStep>) -> AppResult<OpOutcome> {
    head_journaled(
        repo,
        crate::tr!("인터랙티브 리베이스", "Interactive rebase").into(),
        false,
        |r: &OpOutcome| r.ok,
        move |path| history::rebase_interactive(path, &base, &steps),
    )
    .await
}

#[tauri::command]
pub async fn file_blame(repo: String, path: String, rev: Option<String>) -> AppResult<history::Blame> {
    blocking(move || history::blame(&p(&repo), &path, rev.as_deref())).await
}

// ----- self-test (only active when MOBYD_SELFTEST_OUT is set) ------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelftestConfig {
    repo: String,
    remote: Option<String>,
    /// `ko` or `en`: run the checks with that UI language.
    lang: Option<String>,
    /// Stress test: reload the page this many times while requests are in flight.
    stress: Option<u32>,
}

/// In-app end-to-end check: `MOBYD_SELFTEST_OUT=<file> MOBYD_SELFTEST_REPO=<repo> MobyD`
/// drives the real UI inside the real webview, writes a JSON report and quits.
#[tauri::command]
pub fn selftest_config() -> Option<SelftestConfig> {
    std::env::var("MOBYD_SELFTEST_OUT").ok()?;
    Some(SelftestConfig {
        repo: std::env::var("MOBYD_SELFTEST_REPO").ok()?,
        remote: std::env::var("MOBYD_SELFTEST_REMOTE").ok().filter(|s| !s.is_empty()),
        lang: std::env::var("MOBYD_SELFTEST_LANG").ok().filter(|l| l == "ko" || l == "en"),
        stress: std::env::var("MOBYD_SELFTEST_STRESS").ok().and_then(|n| n.parse().ok()),
    })
}

#[tauri::command]
pub fn selftest_finish(app: tauri::AppHandle, report: String) -> AppResult<()> {
    let out = std::env::var("MOBYD_SELFTEST_OUT").map_err(|_| AppError::invalid("self-test is not enabled"))?;
    std::fs::write(out, report)?;
    app.exit(0);
    Ok(())
}

// ----- ssh hosts -------------------------------------------------------------

#[tauri::command]
pub async fn ssh_hosts() -> AppResult<Vec<crate::git::remote::SshHost>> {
    blocking(|| Ok(crate::git::remote::hosts())).await
}

/// List folders on an SSH host (empty `path` = home directory).
#[tauri::command]
pub async fn ssh_list_dir(host: String, path: Option<String>) -> AppResult<crate::git::remote::DirListing> {
    if host.trim().is_empty() || host.starts_with('-') || host.contains(char::is_whitespace) {
        return Err(AppError::invalid(crate::tr!("호스트 이름이 올바르지 않습니다", "Invalid host name")));
    }
    blocking(move || crate::git::remote::list_dir(&host, path.as_deref().unwrap_or(""))).await
}

#[tauri::command]
pub fn ssh_host_prefs(state: State<'_, AppState>) -> AppResult<std::collections::HashMap<String, crate::git::remote::HostPrefs>> {
    ssh_host_prefs_impl(&state)
}

pub fn ssh_host_prefs_impl(state: &AppState) -> AppResult<std::collections::HashMap<String, crate::git::remote::HostPrefs>> {
    Ok(state.settings.lock().unwrap().ssh_hosts.clone())
}

/// MobyD-only per-host settings: shell strategy and an address override (the ssh config is not edited).
#[tauri::command]
pub fn ssh_set_host_prefs(
    state: State<'_, AppState>,
    host: String,
    prefs: crate::git::remote::HostPrefs,
) -> AppResult<std::collections::HashMap<String, crate::git::remote::HostPrefs>> {
    ssh_set_host_prefs_impl(&state, host, prefs)
}

pub fn ssh_set_host_prefs_impl(
    state: &AppState,
    host: String,
    mut prefs: crate::git::remote::HostPrefs,
) -> AppResult<std::collections::HashMap<String, crate::git::remote::HostPrefs>> {
    if let Some(a) = prefs.address.as_ref() {
        let a = a.trim();
        let allowed = |c: char| c.is_ascii_alphanumeric() || ".-_:[]%".contains(c);
        if a.starts_with('-') || !a.chars().all(allowed) {
            return Err(AppError::invalid(crate::tr!("주소가 올바르지 않습니다", "Invalid address")));
        }
        prefs.address = Some(a.to_string()).filter(|a| !a.is_empty());
    }
    let mut s = state.settings.lock().unwrap();
    if prefs == crate::git::remote::HostPrefs::default() {
        s.ssh_hosts.remove(&host);
    } else {
        s.ssh_hosts.insert(host, prefs);
    }
    crate::git::remote::set_host_prefs(s.ssh_hosts.clone());
    state.save(&s)?;
    Ok(s.ssh_hosts.clone())
}

#[tauri::command]
pub async fn ssh_tailscale_peers() -> AppResult<Vec<crate::git::remote::TailscalePeer>> {
    blocking(|| Ok(crate::git::remote::tailscale_peers())).await
}

// ----- network --------------------------------------------------------------

#[tauri::command]
pub async fn remote_fetch(state: State<'_, AppState>, repo: String, remote: Option<String>) -> AppResult<String> {
    remote_fetch_impl(&state, repo, remote).await
}

pub async fn remote_fetch_impl(state: &AppState, repo: String, remote: Option<String>) -> AppResult<String> {
    let env = repo_auth_env(state, &repo);
    writing(repo.clone(), move || ops::fetch(&p(&repo), remote.as_deref(), true, &env)).await
}

#[tauri::command]
pub async fn remote_pull(state: State<'_, AppState>, repo: String, mode: String) -> AppResult<OpOutcome> {
    remote_pull_impl(&state, repo, mode).await
}

pub async fn remote_pull_impl(state: &AppState, repo: String, mode: String) -> AppResult<OpOutcome> {
    let env = repo_auth_env(state, &repo);
    head_journaled(repo, "Pull".into(), false, |r: &OpOutcome| r.ok, move |path| ops::pull(path, &mode, &env)).await
}

#[tauri::command]
pub async fn remote_push(
    state: State<'_, AppState>,
    repo: String,
    remote: Option<String>,
    branch: Option<String>,
    set_upstream: bool,
    force: bool,
) -> AppResult<String> {
    remote_push_impl(&state, repo, remote, branch, set_upstream, force).await
}

pub async fn remote_push_impl(
    state: &AppState,
    repo: String,
    remote: Option<String>,
    branch: Option<String>,
    set_upstream: bool,
    force: bool,
) -> AppResult<String> {
    let env = repo_auth_env(state, &repo);
    writing(repo.clone(), move || ops::push(&p(&repo), remote.as_deref(), branch.as_deref(), set_upstream, force, &env)).await
}

#[tauri::command]
pub async fn remote_list(repo: String) -> AppResult<Vec<repo::Remote>> {
    blocking(move || repo::remotes(&p(&repo))).await
}

#[tauri::command]
pub async fn remote_add(repo: String, name: String, url: String) -> AppResult<String> {
    writing(repo.clone(), move || ops::add_remote(&p(&repo), &name, &url)).await
}

#[tauri::command]
pub async fn remote_remove(repo: String, name: String) -> AppResult<String> {
    writing(repo.clone(), move || ops::remove_remote(&p(&repo), &name)).await
}

// ----- stash ------------------------------------------------------------------

#[tauri::command]
pub async fn stash_save(repo: String, message: Option<String>, include_untracked: bool, staged_only: bool) -> AppResult<String> {
    writing(repo.clone(), move || {
        let path = p(&repo);
        let before = journal::ref_value(&path, "refs/stash");
        let r = ops::stash_save(&path, message.as_deref(), include_untracked, staged_only)?;
        if let Some(sha) = journal::ref_value(&path, "refs/stash").filter(|s| Some(s) != before.as_ref()) {
            journal::record(
                &repo,
                journal::Entry { label: "Stash".into(), actions: vec![journal::Action::StashSave { sha }], redoable: false },
            );
        }
        Ok(r)
    })
    .await
}

#[tauri::command]
pub async fn stash_action(repo: String, action: String, index: u32) -> AppResult<OpOutcome> {
    writing(repo.clone(), move || {
        let path = p(&repo);
        let name = format!("stash@{{{index}}}");
        let saved = if action == "drop" {
            let sha = journal::ref_value(&path, &name);
            let msg =
                runner::run(&path, ["log", "-1", "--format=%gs", "-g", name.as_str()]).unwrap_or_default().trim().to_string();
            sha.map(|s| (s, msg))
        } else {
            None
        };
        let r = ops::stash_action(&path, &action, index)?;
        if let (true, Some((sha, message))) = (r.ok, saved) {
            journal::record(
                &repo,
                journal::Entry {
                    label: crate::tr!("Stash 삭제", "Delete stash").into(),
                    actions: vec![journal::Action::StashDrop { sha, message }],
                    redoable: false,
                },
            );
        }
        Ok(r)
    })
    .await
}

// ----- worktrees ----------------------------------------------------------------

#[tauri::command]
pub async fn worktree_list(repo: String) -> AppResult<Vec<Worktree>> {
    blocking(move || repo::worktrees(&p(&repo))).await
}

#[tauri::command]
pub async fn worktree_add(repo: String, request: WorktreeAdd) -> AppResult<String> {
    writing(repo.clone(), move || ops::worktree_add(&p(&repo), &request)).await
}

#[tauri::command]
pub async fn worktree_remove(repo: String, path: String, force: bool) -> AppResult<String> {
    writing(repo.clone(), move || ops::worktree_remove(&p(&repo), &path, force)).await
}

#[tauri::command]
pub async fn worktree_lock(repo: String, path: String, lock: bool, reason: Option<String>) -> AppResult<String> {
    writing(repo.clone(), move || ops::worktree_lock(&p(&repo), &path, lock, reason.as_deref())).await
}

#[tauri::command]
pub async fn worktree_prune(repo: String) -> AppResult<String> {
    writing(repo.clone(), move || ops::worktree_prune(&p(&repo))).await
}

// ----- forges -----------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeRemote {
    remote: String,
    url: String,
    target: Option<RemoteTarget>,
    kind: Option<ForgeKind>,
    account_id: Option<String>,
    account_user: Option<String>,
    /// `true` when the provider was inferred from the host name only.
    guessed: bool,
    repo_url: Option<String>,
}

fn resolve_remote(settings: &Settings, remote: &repo::Remote) -> ForgeRemote {
    let url = if remote.fetch_url.is_empty() { remote.push_url.clone() } else { remote.fetch_url.clone() };
    let target = forge::parse_remote_url(&url);
    let mut out = ForgeRemote {
        remote: remote.name.clone(),
        url,
        target: target.clone(),
        kind: None,
        account_id: None,
        account_user: None,
        guessed: false,
        repo_url: None,
    };
    let Some(t) = target else { return out };
    let host_only = t.host.split(':').next().unwrap_or_default().to_string();
    let account = settings
        .accounts
        .iter()
        .find(|a| a.host() == t.host)
        .or_else(|| settings.accounts.iter().find(|a| a.host().split(':').next() == Some(host_only.as_str())));
    if let Some(a) = account {
        out.kind = Some(a.kind);
        out.account_id = Some(a.id.clone());
        out.account_user = a.username.clone();
        out.repo_url = Some(format!("{}/{}", forge::normalize_base(&a.base_url), t.path));
    } else if let Some(k) = forge::guess_kind(&t.host) {
        out.kind = Some(k);
        out.guessed = !matches!(host_only.as_str(), "github.com" | "gitlab.com" | "codeberg.org" | "gitea.com");
        out.repo_url = Some(format!("{}/{}", t.web_base, t.path));
    }
    out
}

#[tauri::command]
pub async fn forge_remotes(state: State<'_, AppState>, repo: String) -> AppResult<Vec<ForgeRemote>> {
    forge_remotes_impl(&state, repo).await
}

pub async fn forge_remotes_impl(state: &AppState, repo: String) -> AppResult<Vec<ForgeRemote>> {
    let remotes = blocking(move || repo::remotes(&p(&repo))).await?;
    let settings = state.settings.lock().unwrap().clone();
    Ok(remotes.iter().map(|r| resolve_remote(&settings, r)).collect())
}

fn client_for(state: &AppState, repo_path: &str, remote_name: &str) -> AppResult<(ForgeClient, String)> {
    let remotes = repo::remotes(&p(repo_path))?;
    let remote = remotes.iter().find(|r| r.name == remote_name).ok_or_else(|| {
        AppError::invalid(crate::trf!("원격 '{remote_name}'을 찾을 수 없습니다", "Remote '{remote_name}' not found"))
    })?;
    let settings = state.settings.lock().unwrap().clone();
    let fr = resolve_remote(&settings, remote);
    let target = fr.target.ok_or_else(|| {
        AppError::invalid(crate::tr!(
            "이 원격은 호스팅 서비스 주소가 아닙니다(로컬 경로 원격).",
            "This remote is not a hosting service URL (it is a local path)."
        ))
    })?;
    let kind = fr.kind.ok_or_else(|| {
        AppError::invalid(crate::trf!(
            "{} 호스트의 서비스 종류를 알 수 없습니다. 설정 > 계정에서 GitHub/GitLab/Gitea 계정을 추가하세요.",
            "Unknown service type for host {}. Add a GitHub/GitLab/Gitea account under Preferences > Integrations.",
            target.host
        ))
    })?;
    let account = fr.account_id.as_ref().and_then(|id| settings.accounts.iter().find(|a| &a.id == id));
    let api = match account {
        Some(a) => a.api_url.clone().filter(|u| !u.trim().is_empty()).unwrap_or_else(|| forge::api_base(kind, &a.base_url)),
        None => forge::api_base(kind, &target.web_base),
    };
    let token = account.and_then(|a| state.secrets.get(&a.id));
    Ok((ForgeClient { kind, api, token, http: state.http.clone() }, target.path))
}

#[tauri::command]
pub async fn pr_list(
    state: State<'_, AppState>,
    repo: String,
    remote: String,
    pr_state: String,
) -> AppResult<Vec<forge::PullRequest>> {
    pr_list_impl(&state, repo, remote, pr_state).await
}

pub async fn pr_list_impl(
    state: &AppState,
    repo: String,
    remote: String,
    pr_state: String,
) -> AppResult<Vec<forge::PullRequest>> {
    let (client, path) = client_for(state, &repo, &remote)?;
    client.list(&path, &pr_state).await
}

#[tauri::command]
pub async fn pr_get(state: State<'_, AppState>, repo: String, remote: String, number: u64) -> AppResult<forge::PullRequest> {
    pr_get_impl(&state, repo, remote, number).await
}

pub async fn pr_get_impl(state: &AppState, repo: String, remote: String, number: u64) -> AppResult<forge::PullRequest> {
    let (client, path) = client_for(state, &repo, &remote)?;
    client.get(&path, number).await
}

#[tauri::command]
pub async fn pr_create(
    state: State<'_, AppState>,
    repo: String,
    remote: String,
    request: NewPullRequest,
) -> AppResult<forge::PullRequest> {
    pr_create_impl(&state, repo, remote, request).await
}

pub async fn pr_create_impl(
    state: &AppState,
    repo: String,
    remote: String,
    request: NewPullRequest,
) -> AppResult<forge::PullRequest> {
    let (client, path) = client_for(state, &repo, &remote)?;
    client.create(&path, &request).await
}

#[tauri::command]
pub async fn pr_merge(
    state: State<'_, AppState>,
    repo: String,
    remote: String,
    number: u64,
    options: MergeRequestOptions,
) -> AppResult<String> {
    pr_merge_impl(&state, repo, remote, number, options).await
}

pub async fn pr_merge_impl(
    state: &AppState,
    repo: String,
    remote: String,
    number: u64,
    options: MergeRequestOptions,
) -> AppResult<String> {
    let (client, path) = client_for(state, &repo, &remote)?;
    client.merge(&path, number, &options).await
}

#[tauri::command]
pub async fn pr_close(state: State<'_, AppState>, repo: String, remote: String, number: u64) -> AppResult<()> {
    pr_close_impl(&state, repo, remote, number).await
}

pub async fn pr_close_impl(state: &AppState, repo: String, remote: String, number: u64) -> AppResult<()> {
    let (client, path) = client_for(state, &repo, &remote)?;
    client.close(&path, number).await
}

#[tauri::command]
pub async fn pr_comments(
    state: State<'_, AppState>,
    repo: String,
    remote: String,
    number: u64,
) -> AppResult<Vec<forge::Comment>> {
    pr_comments_impl(&state, repo, remote, number).await
}

pub async fn pr_comments_impl(state: &AppState, repo: String, remote: String, number: u64) -> AppResult<Vec<forge::Comment>> {
    let (client, path) = client_for(state, &repo, &remote)?;
    client.comments(&path, number).await
}

#[tauri::command]
pub async fn pr_add_comment(
    state: State<'_, AppState>,
    repo: String,
    remote: String,
    number: u64,
    body: String,
) -> AppResult<forge::Comment> {
    pr_add_comment_impl(&state, repo, remote, number, body).await
}

pub async fn pr_add_comment_impl(
    state: &AppState,
    repo: String,
    remote: String,
    number: u64,
    body: String,
) -> AppResult<forge::Comment> {
    let (client, path) = client_for(state, &repo, &remote)?;
    client.add_comment(&path, number, &body).await
}

#[tauri::command]
pub async fn pr_checkout(state: State<'_, AppState>, repo: String, remote: String, number: u64) -> AppResult<String> {
    pr_checkout_impl(&state, repo, remote, number).await
}

pub async fn pr_checkout_impl(state: &AppState, repo: String, remote: String, number: u64) -> AppResult<String> {
    let (client, _) = client_for(state, &repo, &remote)?;
    let kind = client.kind;
    writing(repo.clone(), move || {
        ops::checkout_review_ref(&p(&repo), &remote, &kind.review_ref(number), &kind.review_branch(number))
    })
    .await
}

// ----- accounts -----------------------------------------------------------------------

fn account_client(state: &AppState, id: &str) -> AppResult<ForgeClient> {
    let settings = state.settings.lock().unwrap().clone();
    let a = settings
        .accounts
        .iter()
        .find(|a| a.id == id)
        .ok_or_else(|| AppError::invalid(crate::tr!("계정을 찾을 수 없습니다", "Account not found")))?;
    let token = state.secrets.get(&a.id).ok_or_else(|| {
        AppError::invalid(crate::tr!("저장된 토큰이 없습니다. 계정을 다시 연결하세요.", "No saved token. Reconnect the account."))
    })?;
    let api = a.api_url.clone().filter(|u| !u.trim().is_empty()).unwrap_or_else(|| forge::api_base(a.kind, &a.base_url));
    Ok(ForgeClient { kind: a.kind, api, token: Some(token), http: state.http.clone() })
}

/// Repositories reachable with a connected account (GitKraken-style "clone from").
#[tauri::command]
pub async fn account_repos(state: State<'_, AppState>, id: String) -> AppResult<Vec<forge::ForgeRepo>> {
    account_repos_impl(&state, id).await
}

pub async fn account_repos_impl(state: &AppState, id: String) -> AppResult<Vec<forge::ForgeRepo>> {
    account_client(state, &id)?.repos().await
}

fn normalize_remote(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    Some(
        forge::parse_remote_url(url)
            .map(|t| format!("{}/{}", t.host.split(':').next().unwrap_or(&t.host), t.path.to_lowercase()))
            // local-path remotes compare as written
            .unwrap_or_else(|| url.trim_end_matches('/').trim_end_matches(".git").to_string()),
    )
}

/// Local clones (from recent repositories) whose remotes match the given URLs: `url → path`.
#[tauri::command]
pub async fn find_local_clones(
    state: State<'_, AppState>,
    urls: Vec<String>,
) -> AppResult<std::collections::HashMap<String, String>> {
    find_local_clones_impl(&state, urls).await
}

pub async fn find_local_clones_impl(state: &AppState, urls: Vec<String>) -> AppResult<std::collections::HashMap<String, String>> {
    let recent: Vec<String> = state.settings.lock().unwrap().recent.iter().map(|r| r.path.clone()).collect();
    blocking(move || {
        let wanted: Vec<(String, String)> = urls.iter().filter_map(|u| normalize_remote(u).map(|n| (n, u.clone()))).collect();
        let mut found = std::collections::HashMap::new();
        for path in recent.iter().filter(|p| !runner::is_remote(&self::p(p))) {
            let Ok(remotes) = repo::remotes(&self::p(path)) else { continue };
            for r in remotes {
                if let Some(n) = normalize_remote(&r.fetch_url) {
                    for (w, url) in &wanted {
                        if *w == n {
                            found.entry(url.clone()).or_insert_with(|| path.clone());
                        }
                    }
                }
            }
        }
        Ok(found)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    #[serde(flatten)]
    account: Account,
    has_token: bool,
    label: String,
}

fn account_views(state: &AppState) -> Vec<AccountView> {
    // Copy the list first: reading the keychain can wait on an OS prompt, and the
    // settings lock must not be held meanwhile (every other command needs it).
    let accounts = state.settings.lock().unwrap().accounts.clone();
    accounts
        .iter()
        .map(|a| AccountView {
            has_token: state.secrets.get(&a.id).is_some(),
            label: a.kind.label().to_string(),
            account: a.clone(),
        })
        .collect()
}

#[tauri::command]
pub fn accounts_list(state: State<'_, AppState>) -> AppResult<Vec<AccountView>> {
    accounts_list_impl(&state)
}

pub fn accounts_list_impl(state: &AppState) -> AppResult<Vec<AccountView>> {
    Ok(account_views(state))
}

#[tauri::command]
pub async fn account_add(
    state: State<'_, AppState>,
    kind: ForgeKind,
    base_url: String,
    token: String,
    api_url: Option<String>,
) -> AppResult<Vec<AccountView>> {
    account_add_impl(&state, kind, base_url, token, api_url).await
}

pub async fn account_add_impl(
    state: &AppState,
    kind: ForgeKind,
    base_url: String,
    token: String,
    api_url: Option<String>,
) -> AppResult<Vec<AccountView>> {
    let base = forge::normalize_base(&base_url);
    let api = api_url.clone().filter(|u| !u.trim().is_empty()).unwrap_or_else(|| forge::api_base(kind, &base));
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(AppError::invalid(crate::tr!("액세스 토큰을 입력하세요", "Enter an access token")));
    }
    let client = ForgeClient { kind, api, token: Some(token.clone()), http: state.http.clone() };
    let viewer = client.viewer().await?;
    let id = format!("{}:{}:{}", serde_json::to_value(kind)?.as_str().unwrap_or("forge"), forge::host_of(&base), viewer.username);
    let account = Account {
        id: id.clone(),
        kind,
        base_url: base,
        username: Some(viewer.username),
        avatar_url: viewer.avatar_url,
        api_url: api_url.filter(|u| !u.trim().is_empty()),
    };
    state.secrets.set(&id, &token)?;
    {
        let mut s = state.settings.lock().unwrap();
        s.accounts.retain(|a| a.id != id);
        s.accounts.push(account);
        state.save(&s)?;
    }
    Ok(account_views(state))
}

#[tauri::command]
pub fn account_remove(state: State<'_, AppState>, id: String) -> AppResult<Vec<AccountView>> {
    account_remove_impl(&state, id)
}

pub fn account_remove_impl(state: &AppState, id: String) -> AppResult<Vec<AccountView>> {
    state.secrets.delete(&id)?;
    {
        let mut s = state.settings.lock().unwrap();
        s.accounts.retain(|a| a.id != id);
        state.save(&s)?;
    }
    Ok(account_views(state))
}

/// UI language for backend messages ("ko" or "en").
#[tauri::command]
pub fn set_locale(lang: String) {
    crate::i18n::set_english(lang == "en");
}

/// Whether browser sign-in is available for a server (an OAuth client ID is known).
#[tauri::command]
pub fn oauth_available(state: State<'_, AppState>, kind: ForgeKind, base_url: String) -> bool {
    oauth_available_impl(&state, kind, base_url)
}

pub fn oauth_available_impl(state: &AppState, kind: ForgeKind, base_url: String) -> bool {
    let ids = state.settings.lock().unwrap().oauth_client_ids.clone();
    forge::oauth::client_id(kind, &base_url, &ids).is_some()
}

/// Start browser sign-in: returns the code to show and the page to open.
#[tauri::command]
pub async fn oauth_device_start(
    state: State<'_, AppState>,
    kind: ForgeKind,
    base_url: String,
) -> AppResult<forge::oauth::DeviceStart> {
    oauth_device_start_impl(&state, kind, base_url).await
}

pub async fn oauth_device_start_impl(
    state: &AppState,
    kind: ForgeKind,
    base_url: String,
) -> AppResult<forge::oauth::DeviceStart> {
    let ids = state.settings.lock().unwrap().oauth_client_ids.clone();
    let client = forge::oauth::client_id(kind, &base_url, &ids).ok_or_else(|| {
        AppError::invalid(crate::tr!(
            "이 서버에는 브라우저 로그인용 OAuth 앱이 설정되어 있지 않습니다. 토큰으로 연결하세요.",
            "No OAuth app is set up for browser sign-in on this server. Connect with a token."
        ))
    })?;
    forge::oauth::start(&state.http, kind, &base_url, &client).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePoll {
    /// `pending`, `done`, `denied` or `expired`.
    status: &'static str,
    interval: u64,
    accounts: Option<Vec<AccountView>>,
}

/// Check once whether the user approved the code; on approval the account is saved.
#[tauri::command]
pub async fn oauth_device_poll(state: State<'_, AppState>, flow_id: String) -> AppResult<DevicePoll> {
    oauth_device_poll_impl(&state, flow_id).await
}

pub async fn oauth_device_poll_impl(state: &AppState, flow_id: String) -> AppResult<DevicePoll> {
    use forge::oauth::Poll;
    Ok(match forge::oauth::poll(&state.http, &flow_id).await? {
        Poll::Pending(interval) => DevicePoll { status: "pending", interval, accounts: None },
        Poll::Denied => DevicePoll { status: "denied", interval: 0, accounts: None },
        Poll::Expired => DevicePoll { status: "expired", interval: 0, accounts: None },
        Poll::Token { kind, base, token } => {
            let accounts = account_add_impl(state, kind, base, token, None).await?;
            DevicePoll { status: "done", interval: 0, accounts: Some(accounts) }
        }
    })
}

#[tauri::command]
pub fn oauth_device_cancel(flow_id: String) {
    forge::oauth::cancel(&flow_id);
}

fn gh_path() -> Option<String> {
    ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]
        .iter()
        .find(|c| std::path::Path::new(c).is_file())
        .map(|c| c.to_string())
}

/// Whether the GitHub CLI is installed (its login can be imported).
#[tauri::command]
pub fn gh_cli_available() -> bool {
    gh_path().is_some()
}

/// Create a GitHub account from the token the GitHub CLI already holds.
#[tauri::command]
pub async fn account_import_gh(state: State<'_, AppState>, host: Option<String>) -> AppResult<Vec<AccountView>> {
    account_import_gh_impl(&state, host).await
}

pub async fn account_import_gh_impl(state: &AppState, host: Option<String>) -> AppResult<Vec<AccountView>> {
    let host = host.unwrap_or_else(|| "github.com".into());
    let h = host.clone();
    let token = blocking(move || {
        let gh = gh_path().unwrap_or_else(|| "gh".into());
        let out = std::process::Command::new(gh)
            .args(["auth", "token", "--hostname", &h])
            .output()
            .map_err(|_| AppError::invalid(crate::tr!("GitHub CLI(gh)를 찾을 수 없습니다", "GitHub CLI (gh) not found")))?;
        if !out.status.success() {
            return Err(AppError::invalid(crate::trf!(
                "gh auth token 실패: {}",
                "gh auth token failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await?;
    let base = if host == "github.com" { "https://github.com".to_string() } else { format!("https://{host}") };
    account_add_impl(state, ForgeKind::Github, base, token, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_with_token(dir: &std::path::Path) -> AppState {
        let id = format!("github:github.com:mobyd-test-{}", std::process::id());
        std::fs::write(dir.join("secrets.json"), format!("{{\"{id}\":\"tok123\"}}")).unwrap();
        let state = crate::build_state(dir).unwrap();
        state.settings.lock().unwrap().accounts.push(forge::Account {
            id,
            kind: ForgeKind::Github,
            base_url: "https://github.com".into(),
            username: Some("me".into()),
            avatar_url: None,
            api_url: None,
        });
        state
    }

    #[test]
    fn auth_env_scopes_tokens_to_matching_https_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_token(dir.path());
        let env = auth_env(
            &state,
            &["https://github.com/pod/app.git".into(), "git@github.com:pod/app.git".into(), "https://gitlab.com/x/y.git".into()],
        );
        assert_eq!(env[0], ("GIT_CONFIG_COUNT".into(), "1".into()));
        assert_eq!(env[1], ("GIT_CONFIG_KEY_0".into(), "http.https://github.com/.extraHeader".into()));
        assert_eq!(env[2].1, format!("Authorization: Basic {}", crate::git::remote::base64(b"x-access-token:tok123")));
        assert!(auth_env(&state, &["git@github.com:pod/app.git".into()]).is_empty(), "ssh remotes never get tokens");
    }

    #[test]
    fn normalizes_remote_urls_for_clone_lookup() {
        assert_eq!(normalize_remote("git@github.com:Pod/App.git"), normalize_remote("https://github.com/pod/app"));
        assert_eq!(normalize_remote("/srv/git/pod.git").as_deref(), Some("/srv/git/pod"));
        assert_eq!(normalize_remote(""), None);
    }
}
