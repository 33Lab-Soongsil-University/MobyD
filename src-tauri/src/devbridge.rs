//! Development-only HTTP bridge (`--features devbridge`).
//!
//! Serves the exact same command implementations over `POST /invoke/<cmd>` so
//! the React UI can run in a plain browser against real repositories. The
//! frontend switches to it automatically when it is not inside Tauri and
//! `VITE_DEVBRIDGE` is set. It only listens on 127.0.0.1.

use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::commands::{self as c, AppState};
use crate::error::{AppError, AppResult};

fn a<T: DeserializeOwned>(args: &Value, key: &str) -> AppResult<T> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| AppError::invalid(format!("argument {key}: {e}")))
}

fn v<T: serde::Serialize>(r: AppResult<T>) -> AppResult<Value> {
    r.and_then(|x| Ok(serde_json::to_value(x)?))
}

fn dispatch(state: &AppState, cmd: &str, x: &Value) -> AppResult<Value> {
    use tauri::async_runtime::block_on as b;
    match cmd {
        "app_info" => v(b(c::app_info())),
        "settings_get" => v(c::settings_get_impl(state)),
        "settings_save_tabs" => v(c::settings_save_tabs_impl(state, a(x, "tabs")?, a(x, "active")?)),
        "settings_save_prefs" => v(c::settings_save_prefs_impl(state, a(x, "prefs")?)),
        "recent_remove" => v(c::recent_remove_impl(state, a(x, "path")?)),
        "repo_open" => v(b(c::repo_open_impl(state, a(x, "path")?))),
        "repo_init" => v(b(c::repo_init(a(x, "path")?))),
        "repo_clone" => v(b(c::repo_clone_impl(state, a(x, "url")?, a(x, "dest")?))),
        "repo_fingerprint" => v(b(c::repo_fingerprint(a(x, "repo")?))),
        "repo_graph" => v(b(c::repo_graph_impl(state, a(x, "repo")?, a(x, "limit")?, a(x, "showStashes")?))),
        "repo_status" => v(b(c::repo_status(a(x, "repo")?))),
        "commit_detail" => v(b(c::commit_detail(a(x, "repo")?, a(x, "sha")?))),
        "file_diff" => v(b(c::file_diff(a(x, "repo")?, a(x, "request")?))),
        "file_history" => v(b(c::file_history(a(x, "repo")?, a(x, "path")?, a(x, "limit")?))),
        "stage_paths" => v(b(c::stage_paths(a(x, "repo")?, a(x, "paths")?))),
        "unstage_paths" => v(b(c::unstage_paths(a(x, "repo")?, a(x, "paths")?))),
        "discard_paths" => v(b(c::discard_paths(a(x, "repo")?, a(x, "tracked")?, a(x, "untracked")?))),
        "apply_patch" => v(b(c::apply_patch(a(x, "repo")?, a(x, "patch")?, a(x, "cached")?, a(x, "reverse")?))),
        "commit_create" => v(b(c::commit_create(a(x, "repo")?, a(x, "message")?, a(x, "amend")?))),
        "commit_last_message" => v(b(c::commit_last_message(a(x, "repo")?))),
        "branch_checkout" => v(b(c::branch_checkout(a(x, "repo")?, a(x, "name")?, a(x, "remote")?, a(x, "localName")?))),
        "checkout_detached" => v(b(c::checkout_detached(a(x, "repo")?, a(x, "rev")?))),
        "branch_create" => v(b(c::branch_create(a(x, "repo")?, a(x, "name")?, a(x, "start")?, a(x, "checkout")?))),
        "branch_delete" => v(b(c::branch_delete(a(x, "repo")?, a(x, "name")?, a(x, "force")?))),
        "branch_delete_remote" => v(b(c::branch_delete_remote(a(x, "repo")?, a(x, "remote")?, a(x, "branch")?))),
        "branch_rename" => v(b(c::branch_rename(a(x, "repo")?, a(x, "old")?, a(x, "new")?))),
        "branch_set_upstream" => v(b(c::branch_set_upstream(a(x, "repo")?, a(x, "branch")?, a(x, "upstream")?))),
        "branch_fast_forward" => v(b(c::branch_fast_forward(a(x, "repo")?, a(x, "branch")?, a(x, "upstream")?))),
        "open_terminal" => Ok(Value::Null),
        "ssh_hosts" => v(b(c::ssh_hosts())),
        "ssh_host_prefs" => v(c::ssh_host_prefs_impl(state)),
        "ssh_set_host_prefs" => v(c::ssh_set_host_prefs_impl(state, a(x, "host")?, a(x, "prefs")?)),
        "ssh_tailscale_peers" => v(b(c::ssh_tailscale_peers())),
        "set_locale" => {
            c::set_locale(a(x, "lang")?);
            Ok(Value::Null)
        }
        "oauth_available" => v(Ok(c::oauth_available_impl(state, a(x, "kind")?, a(x, "baseUrl")?))),
        "oauth_device_start" => v(b(c::oauth_device_start_impl(state, a(x, "kind")?, a(x, "baseUrl")?))),
        "oauth_device_poll" => v(b(c::oauth_device_poll_impl(state, a(x, "flowId")?))),
        "oauth_device_cancel" => {
            c::oauth_device_cancel(a(x, "flowId")?);
            Ok(Value::Null)
        }
        "gh_cli_available" => v(Ok(c::gh_cli_available())),
        "take_pending_links" => v(Ok(crate::deeplink::take_pending_links())),
        "undo" => v(b(c::undo(a(x, "repo")?))),
        "redo" => v(b(c::redo(a(x, "repo")?))),
        "undo_state" => v(c::undo_state(a(x, "repo")?)),
        "rebase_plan" => v(b(c::rebase_plan(a(x, "repo")?, a(x, "base")?))),
        "rebase_interactive" => v(b(c::rebase_interactive(a(x, "repo")?, a(x, "base")?, a(x, "steps")?))),
        "file_blame" => v(b(c::file_blame(a(x, "repo")?, a(x, "path")?, a(x, "rev")?))),
        "ssh_list_dir" => v(b(c::ssh_list_dir(a(x, "host")?, a(x, "path")?))),
        "merge_ref" => v(b(c::merge_ref(a(x, "repo")?, a(x, "rev")?, a(x, "mode")?, a(x, "message")?))),
        "rebase_onto" => v(b(c::rebase_onto(a(x, "repo")?, a(x, "onto")?))),
        "cherry_pick" => v(b(c::cherry_pick(a(x, "repo")?, a(x, "sha")?))),
        "revert_commit" => v(b(c::revert_commit(a(x, "repo")?, a(x, "sha")?))),
        "reset_to" => v(b(c::reset_to(a(x, "repo")?, a(x, "sha")?, a(x, "mode")?))),
        "sequencer" => v(b(c::sequencer(a(x, "repo")?, a(x, "operation")?, a(x, "action")?))),
        "conflict_resolve" => v(b(c::conflict_resolve(a(x, "repo")?, a(x, "path")?, a(x, "side")?))),
        "tag_create" => v(b(c::tag_create(a(x, "repo")?, a(x, "name")?, a(x, "rev")?, a(x, "message")?))),
        "tag_delete" => v(b(c::tag_delete(a(x, "repo")?, a(x, "name")?))),
        "tag_push" => v(b(c::tag_push(a(x, "repo")?, a(x, "remote")?, a(x, "name")?))),
        "remote_fetch" => v(b(c::remote_fetch_impl(state, a(x, "repo")?, a(x, "remote")?))),
        "remote_pull" => v(b(c::remote_pull_impl(state, a(x, "repo")?, a(x, "mode")?))),
        "remote_push" => v(b(c::remote_push_impl(
            state,
            a(x, "repo")?,
            a(x, "remote")?,
            a(x, "branch")?,
            a(x, "setUpstream")?,
            a(x, "force")?,
        ))),
        "remote_list" => v(b(c::remote_list(a(x, "repo")?))),
        "remote_add" => v(b(c::remote_add(a(x, "repo")?, a(x, "name")?, a(x, "url")?))),
        "remote_remove" => v(b(c::remote_remove(a(x, "repo")?, a(x, "name")?))),
        "stash_save" => v(b(c::stash_save(a(x, "repo")?, a(x, "message")?, a(x, "includeUntracked")?, a(x, "stagedOnly")?))),
        "stash_action" => v(b(c::stash_action(a(x, "repo")?, a(x, "action")?, a(x, "index")?))),
        "worktree_list" => v(b(c::worktree_list(a(x, "repo")?))),
        "worktree_add" => v(b(c::worktree_add(a(x, "repo")?, a(x, "request")?))),
        "worktree_remove" => v(b(c::worktree_remove(a(x, "repo")?, a(x, "path")?, a(x, "force")?))),
        "worktree_lock" => v(b(c::worktree_lock(a(x, "repo")?, a(x, "path")?, a(x, "lock")?, a(x, "reason")?))),
        "worktree_prune" => v(b(c::worktree_prune(a(x, "repo")?))),
        "forge_remotes" => v(b(c::forge_remotes_impl(state, a(x, "repo")?))),
        "pr_list" => v(b(c::pr_list_impl(state, a(x, "repo")?, a(x, "remote")?, a(x, "prState")?))),
        "pr_get" => v(b(c::pr_get_impl(state, a(x, "repo")?, a(x, "remote")?, a(x, "number")?))),
        "pr_create" => v(b(c::pr_create_impl(state, a(x, "repo")?, a(x, "remote")?, a(x, "request")?))),
        "pr_merge" => v(b(c::pr_merge_impl(state, a(x, "repo")?, a(x, "remote")?, a(x, "number")?, a(x, "options")?))),
        "pr_close" => v(b(c::pr_close_impl(state, a(x, "repo")?, a(x, "remote")?, a(x, "number")?))),
        "pr_comments" => v(b(c::pr_comments_impl(state, a(x, "repo")?, a(x, "remote")?, a(x, "number")?))),
        "pr_add_comment" => v(b(c::pr_add_comment_impl(state, a(x, "repo")?, a(x, "remote")?, a(x, "number")?, a(x, "body")?))),
        "pr_checkout" => v(b(c::pr_checkout_impl(state, a(x, "repo")?, a(x, "remote")?, a(x, "number")?))),
        "accounts_list" => v(c::accounts_list_impl(state)),
        "account_add" => v(b(c::account_add_impl(state, a(x, "kind")?, a(x, "baseUrl")?, a(x, "token")?, a(x, "apiUrl")?))),
        "account_remove" => v(c::account_remove_impl(state, a(x, "id")?)),
        "account_repos" => v(b(c::account_repos_impl(state, a(x, "id")?))),
        "find_local_clones" => v(b(c::find_local_clones_impl(state, a(x, "urls")?))),
        "account_import_gh" => v(b(c::account_import_gh_impl(state, a(x, "host")?))),
        // Native dialogs/opener have no browser equivalent; the UI tolerates null.
        _ if cmd.starts_with("plugin:") => Ok(Value::Null),
        other => Err(AppError::invalid(format!("unknown command {other}"))),
    }
}

pub fn serve(port: u16, config_dir: PathBuf) -> AppResult<()> {
    let state = std::sync::Arc::new(crate::build_state(&config_dir)?);
    let server = tiny_http::Server::http(("127.0.0.1", port)).map_err(|e| AppError::invalid(e.to_string()))?;
    eprintln!("mobyd devbridge on http://127.0.0.1:{port} (config: {})", config_dir.display());
    let cors = [
        tiny_http::Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap(),
        tiny_http::Header::from_bytes("Access-Control-Allow-Headers", "content-type").unwrap(),
        tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap(),
    ];
    for mut req in server.incoming_requests() {
        let state = state.clone();
        let cors = cors.clone();
        std::thread::spawn(move || {
            if req.method() == &tiny_http::Method::Options {
                let mut resp = tiny_http::Response::empty(204);
                for h in &cors {
                    resp.add_header(h.clone());
                }
                let _ = req.respond(resp);
                return;
            }
            let cmd = req.url().trim_start_matches("/invoke/").to_string();
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let args: Value = serde_json::from_str(&body).unwrap_or(json!({}));
            let (code, payload) = match dispatch(&state, &cmd, &args) {
                Ok(v) => (200, v),
                Err(e) => (400, json!(e.to_string())),
            };
            let mut resp = tiny_http::Response::from_string(payload.to_string()).with_status_code(code);
            for h in &cors {
                resp.add_header(h.clone());
            }
            let _ = req.respond(resp);
        });
    }
    Ok(())
}
