use serde::Serialize;

/// Error type returned by every Tauri command. It serializes to a plain
/// string so the frontend can show it directly in a toast.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Git(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Http(String),
    #[error("{0}")]
    Invalid(String),
}

impl AppError {
    pub fn invalid(msg: impl Into<String>) -> Self {
        AppError::Invalid(msg.into())
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Http(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Invalid(format!("JSON: {e}"))
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        AppError::Invalid(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
