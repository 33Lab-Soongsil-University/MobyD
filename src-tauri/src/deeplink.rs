//! `mobyd://` links: a web page (or any app) can open MobyD with
//! `mobyd://open?path=<repository>` or `mobyd://clone?url=<remote>`.
//! macOS delivers them through `RunEvent::Opened`; other platforms pass the
//! URL as a command-line argument. Links wait here until the webview takes
//! them, so a link that launched the app is not lost before the UI is ready.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

pub const SCHEME: &str = "mobyd:";

static PENDING: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Keep only our scheme (case-insensitive) and cap the length.
pub fn accept(urls: impl IntoIterator<Item = String>) -> Vec<String> {
    urls.into_iter()
        .filter(|u| u.len() <= 4096 && u.get(..SCHEME.len()).is_some_and(|p| p.eq_ignore_ascii_case(SCHEME)))
        .collect()
}

/// Store links, bring the window forward and tell the webview to pick them up.
pub fn receive(app: &AppHandle, urls: Vec<String>) {
    let urls = accept(urls);
    if urls.is_empty() {
        return;
    }
    if let Ok(path) = std::env::var("MOBYD_DEEPLINK_PROBE") {
        // test hook: record what the OS delivered
        let _ = std::fs::write(path, urls.join("\n"));
    }
    PENDING.lock().unwrap().extend(urls);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit("mobyd-link", ());
}

/// Links given on the command line (Windows/Linux URL handlers start the app this way).
pub fn from_args() -> Vec<String> {
    accept(std::env::args().skip(1))
}

pub fn push(urls: Vec<String>) {
    PENDING.lock().unwrap().extend(accept(urls));
}

/// The webview takes the links it has not handled yet.
#[tauri::command]
pub fn take_pending_links() -> Vec<String> {
    std::mem::take(&mut *PENDING.lock().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_mobyd_links() {
        let got = accept(vec![
            "mobyd://open?path=%2Ftmp%2Fr".into(),
            "MOBYD://clone?url=x".into(),
            "https://evil.example".into(),
            "--flag".into(),
            format!("mobyd://{}", "a".repeat(5000)),
        ]);
        assert_eq!(got, vec!["mobyd://open?path=%2Ftmp%2Fr".to_string(), "MOBYD://clone?url=x".to_string()]);
    }
}
