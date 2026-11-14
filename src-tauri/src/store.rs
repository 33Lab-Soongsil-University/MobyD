//! Persistent settings (JSON in the app config dir) and secret storage
//! (OS keychain, with a private file as a fallback where no keychain exists).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::forge::Account;

const SERVICE: &str = "org.mobyd.desktop";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentRepo {
    pub path: String,
    pub name: String,
    pub last_opened: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub recent: Vec<RecentRepo>,
    pub accounts: Vec<Account>,
    pub open_tabs: Vec<String>,
    pub active_tab: Option<String>,
    pub prefs: serde_json::Value,
    /// MobyD-only SSH host settings (shell strategy, address override).
    pub ssh_hosts: std::collections::HashMap<String, crate::git::remote::HostPrefs>,
    /// OAuth app client IDs for servers other than github.com (host → client ID).
    pub oauth_client_ids: std::collections::HashMap<String, String>,
}

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

impl Settings {
    pub fn load(path: &Path) -> Settings {
        std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> AppResult<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    pub fn touch_recent(&mut self, path: &str, name: &str) {
        self.recent.retain(|r| r.path != path);
        self.recent.insert(0, RecentRepo { path: path.into(), name: name.into(), last_opened: now() });
        self.recent.truncate(30);
    }
}

/// Stores API tokens. Tries the OS keychain first; falls back to a 0600 file.
pub struct Secrets {
    fallback: PathBuf,
}

impl Secrets {
    pub fn new(config_dir: &Path) -> Self {
        Secrets { fallback: config_dir.join("secrets.json") }
    }

    fn read_fallback(&self) -> BTreeMap<String, String> {
        std::fs::read_to_string(&self.fallback).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    fn write_fallback(&self, map: &BTreeMap<String, String>) -> AppResult<()> {
        if let Some(dir) = self.fallback.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&self.fallback, serde_json::to_vec(map)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.fallback, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    pub fn set(&self, id: &str, token: &str) -> AppResult<()> {
        let keychain = keyring::Entry::new(SERVICE, id).and_then(|e| e.set_password(token));
        if keychain.is_ok() && self.get_keychain(id).as_deref() == Some(token) {
            let mut map = self.read_fallback();
            if map.remove(id).is_some() {
                self.write_fallback(&map)?;
            }
            return Ok(());
        }
        let mut map = self.read_fallback();
        map.insert(id.to_string(), token.to_string());
        self.write_fallback(&map)
    }

    fn get_keychain(&self, id: &str) -> Option<String> {
        keyring::Entry::new(SERVICE, id).ok()?.get_password().ok()
    }

    pub fn get(&self, id: &str) -> Option<String> {
        self.get_keychain(id).or_else(|| self.read_fallback().get(id).cloned())
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        if let Ok(e) = keyring::Entry::new(SERVICE, id) {
            let _ = e.delete_credential();
        }
        let mut map = self.read_fallback();
        if map.remove(id).is_some() {
            self.write_fallback(&map)?;
        }
        Ok(())
    }
}

pub fn config_path(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

pub fn ensure_dir(dir: &Path) -> AppResult<()> {
    std::fs::create_dir_all(dir).map_err(|e| {
        AppError::invalid(crate::trf!("설정 폴더를 만들 수 없습니다: {e}", "Could not create the settings folder: {e}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_roundtrip_and_recent_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_path(dir.path());
        let mut s = Settings::load(&path);
        assert!(s.recent.is_empty());
        s.touch_recent("/a", "a");
        s.touch_recent("/b", "b");
        s.touch_recent("/a", "a");
        s.save(&path).unwrap();
        let loaded = Settings::load(&path);
        assert_eq!(loaded.recent.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(), vec!["/a", "/b"]);
    }
}
