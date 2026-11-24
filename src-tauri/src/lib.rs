mod commands;
pub mod deeplink;
#[cfg(feature = "devbridge")]
pub mod devbridge;
mod error;
mod forge;
mod git;
pub mod i18n;
mod journal;
mod store;

use std::path::Path;
use std::sync::Mutex;

use tauri::Manager;

use commands::AppState;

/// Shared state used by the Tauri app and the dev bridge.
pub(crate) fn build_state(dir: &Path) -> error::AppResult<AppState> {
    store::ensure_dir(dir)?;
    let settings_path = store::config_path(dir);
    let settings = store::Settings::load(&settings_path);
    git::remote::set_host_prefs(settings.ssh_hosts.clone());
    let http = reqwest::Client::builder()
        .user_agent(concat!("MobyD/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    Ok(AppState { settings: Mutex::new(settings), settings_path, secrets: store::Secrets::new(dir), http })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // A self-test run can keep its settings apart from the user's (see `selftest_config`).
            let dir = match (std::env::var_os("MOBYD_SELFTEST_OUT"), std::env::var_os("MOBYD_SELFTEST_CONFIG")) {
                (Some(_), Some(d)) => std::path::PathBuf::from(d),
                _ => app.path().app_config_dir()?,
            };
            app.manage(build_state(&dir)?);
            deeplink::push(deeplink::from_args());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::settings_get,
            commands::settings_save_tabs,
            commands::settings_save_prefs,
            commands::recent_remove,
            commands::repo_open,
            commands::repo_init,
            commands::repo_clone,
            commands::repo_fingerprint,
            commands::repo_graph,
            commands::repo_status,
            commands::commit_detail,
            commands::file_diff,
            commands::file_history,
            commands::stage_paths,
            commands::unstage_paths,
            commands::discard_paths,
            commands::apply_patch,
            commands::commit_create,
            commands::commit_last_message,
            commands::branch_checkout,
            commands::checkout_detached,
            commands::branch_create,
            commands::branch_delete,
            commands::branch_delete_remote,
            commands::branch_rename,
            commands::branch_set_upstream,
            commands::branch_fast_forward,
            commands::open_terminal,
            commands::ssh_hosts,
            commands::selftest_config,
            commands::selftest_finish,
            commands::undo,
            commands::redo,
            commands::undo_state,
            commands::rebase_plan,
            commands::rebase_interactive,
            commands::file_blame,
            commands::ssh_list_dir,
            commands::ssh_host_prefs,
            commands::ssh_set_host_prefs,
            commands::set_locale,
            commands::oauth_available,
            commands::oauth_device_start,
            commands::oauth_device_poll,
            commands::oauth_device_cancel,
            commands::gh_cli_available,
            commands::ssh_tailscale_peers,
            commands::merge_ref,
            commands::rebase_onto,
            commands::cherry_pick,
            commands::revert_commit,
            commands::reset_to,
            commands::sequencer,
            commands::conflict_resolve,
            commands::tag_create,
            commands::tag_delete,
            commands::tag_push,
            commands::remote_fetch,
            commands::remote_pull,
            commands::remote_push,
            commands::remote_list,
            commands::remote_use_ssh_key,
            commands::remote_add,
            commands::remote_remove,
            commands::stash_save,
            commands::stash_action,
            commands::worktree_list,
            commands::worktree_add,
            commands::worktree_remove,
            commands::worktree_lock,
            commands::worktree_prune,
            commands::forge_remotes,
            commands::pr_list,
            commands::pr_get,
            commands::pr_create,
            commands::pr_merge,
            commands::pr_close,
            commands::pr_comments,
            commands::pr_add_comment,
            commands::pr_checkout,
            commands::accounts_list,
            commands::account_add,
            commands::account_remove,
            commands::account_import_gh,
            commands::account_repos,
            commands::find_local_clones,
            deeplink::take_pending_links,
        ])
        .build(tauri::generate_context!())
        .expect("error while building MobyD")
        .run(|app, event| {
            // macOS hands mobyd:// links to the running app (also when the link launched it).
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = event {
                deeplink::receive(app, urls.into_iter().map(|u| u.to_string()).collect());
            }
            #[cfg(not(any(target_os = "macos", target_os = "ios")))]
            let _ = (app, event);
        });
}
