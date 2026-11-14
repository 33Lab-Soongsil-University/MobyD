//! Browser sign-in with the OAuth 2.0 device authorization grant (RFC 8628),
//! the flow GitHub and GitLab offer to desktop apps: MobyD asks for a short
//! code, the user approves it in their browser, and MobyD polls for the
//! token. No client secret is involved, so nothing secret ships in the app.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use super::{host_of, normalize_base, ForgeKind};
use crate::error::{AppError, AppResult};

/// MobyD's GitHub OAuth app (device flow enabled, non-expiring user tokens).
/// A client ID is public by design; it identifies the app on the consent screen.
pub const GITHUB_CLIENT_ID: &str = "Ov23lieIItaI2GuawY0B";

/// Scopes: private repositories and pushes (`repo`), organisation repositories
/// (`read:org`), the profile (`read:user`) and pushing workflow files (`workflow`).
pub const GITHUB_SCOPES: &str = "repo read:org read:user workflow";
pub const GITLAB_SCOPES: &str = "api read_user read_repository write_repository";

/// The OAuth client to use for a server: an explicit setting, then
/// `MOBYD_<KIND>_CLIENT_ID`, then the built-in app for github.com.
pub fn client_id(kind: ForgeKind, base: &str, configured: &HashMap<String, String>) -> Option<String> {
    let host = host_of(&normalize_base(base));
    if let Some(id) = configured.get(&host).filter(|s| !s.trim().is_empty()) {
        return Some(id.trim().to_string());
    }
    let env = match kind {
        ForgeKind::Github => "MOBYD_GITHUB_CLIENT_ID",
        ForgeKind::Gitlab => "MOBYD_GITLAB_CLIENT_ID",
        ForgeKind::Gitea => return None,
    };
    if let Ok(id) = std::env::var(env) {
        if !id.trim().is_empty() {
            return Some(id.trim().to_string());
        }
    }
    (kind == ForgeKind::Github && host == "github.com").then(|| GITHUB_CLIENT_ID.to_string())
}

fn endpoints(kind: ForgeKind, base: &str) -> AppResult<(String, String, &'static str)> {
    let b = normalize_base(base);
    match kind {
        ForgeKind::Github => Ok((format!("{b}/login/device/code"), format!("{b}/login/oauth/access_token"), GITHUB_SCOPES)),
        ForgeKind::Gitlab => Ok((format!("{b}/oauth/authorize_device"), format!("{b}/oauth/token"), GITLAB_SCOPES)),
        ForgeKind::Gitea => Err(AppError::invalid(crate::tr!(
            "Gitea는 브라우저 로그인을 지원하지 않습니다. 토큰으로 연결하세요.",
            "Gitea has no browser sign-in. Connect with a token."
        ))),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    pub flow_id: String,
    pub user_code: String,
    pub verification_uri: String,
    /// Opens the approval page with the code already filled in (GitLab).
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
}

struct Flow {
    kind: ForgeKind,
    base: String,
    client_id: String,
    device_code: String,
    token_url: String,
    expires: Instant,
}

fn flows() -> &'static Mutex<HashMap<String, Flow>> {
    static F: OnceLock<Mutex<HashMap<String, Flow>>> = OnceLock::new();
    F.get_or_init(Default::default)
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string()
}

async fn post_form(http: &reqwest::Client, url: &str, form: &[(&str, &str)]) -> AppResult<Value> {
    let resp = http
        .post(url)
        .header("Accept", "application/json")
        .header("User-Agent", "MobyD")
        .form(form)
        .send()
        .await
        .map_err(|e| AppError::Http(crate::trf!("{url} 연결 실패: {e}", "Could not reach {url}: {e}")))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    // Device-flow errors (authorization_pending, slow_down…) come back as JSON with 400 on GitLab.
    if v.get("error").is_some() || status.is_success() {
        return Ok(v);
    }
    Err(AppError::Http(crate::trf!(
        "{url} 응답 {status}: {text}",
        "{url} answered {status}: {text}",
        status = status.as_u16(),
        text = text.chars().take(200).collect::<String>()
    )))
}

/// Ask the server for a user code. The device code stays in this process.
pub async fn start(http: &reqwest::Client, kind: ForgeKind, base: &str, client_id: &str) -> AppResult<DeviceStart> {
    let (code_url, token_url, scopes) = endpoints(kind, base)?;
    let v = post_form(http, &code_url, &[("client_id", client_id), ("scope", scopes)]).await?;
    if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
        let detail = s(&v, "error_description");
        return Err(AppError::invalid(match e {
            "device_flow_disabled" => crate::tr!(
                "이 OAuth 앱은 기기 로그인(Device Flow)이 꺼져 있습니다.",
                "Device flow is disabled for this OAuth app."
            )
            .to_string(),
            _ => crate::trf!(
                "브라우저 로그인을 시작하지 못했습니다: {e} {detail}",
                "Could not start browser sign-in: {e} {detail}"
            ),
        }));
    }
    let device_code = s(&v, "device_code");
    let user_code = s(&v, "user_code");
    if device_code.is_empty() || user_code.is_empty() {
        return Err(AppError::Http(
            crate::tr!("서버가 로그인 코드를 주지 않았습니다", "The server returned no sign-in code").into(),
        ));
    }
    let expires_in = v.get("expires_in").and_then(|x| x.as_u64()).unwrap_or(900);
    let interval = v.get("interval").and_then(|x| x.as_u64()).unwrap_or(5).max(1);
    let flow_id = format!("{:x}", rand_id());
    flows().lock().unwrap().insert(
        flow_id.clone(),
        Flow {
            kind,
            base: normalize_base(base),
            client_id: client_id.to_string(),
            device_code,
            token_url,
            expires: Instant::now() + Duration::from_secs(expires_in),
        },
    );
    Ok(DeviceStart {
        flow_id,
        user_code,
        verification_uri: s(&v, "verification_uri"),
        verification_uri_complete: Some(s(&v, "verification_uri_complete")).filter(|u| !u.is_empty()),
        expires_in,
        interval,
    })
}

fn rand_id() -> u128 {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    t ^ ((N.fetch_add(1, std::sync::atomic::Ordering::Relaxed) as u128) << 96) ^ ((std::process::id() as u128) << 64)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Poll {
    /// Not approved yet; wait this many seconds before asking again.
    Pending(u64),
    /// Approved: the access token, plus the server it belongs to.
    Token {
        kind: ForgeKind,
        base: String,
        token: String,
    },
    Denied,
    Expired,
}

/// Ask once whether the user approved the code.
pub async fn poll(http: &reqwest::Client, flow_id: &str) -> AppResult<Poll> {
    let (url, client_id, device_code, kind, base, expired) = {
        let map = flows().lock().unwrap();
        let f = map.get(flow_id).ok_or_else(|| {
            AppError::invalid(crate::tr!(
                "로그인 요청이 끝났습니다. 다시 시작하세요.",
                "This sign-in request has ended. Start again."
            ))
        })?;
        (f.token_url.clone(), f.client_id.clone(), f.device_code.clone(), f.kind, f.base.clone(), Instant::now() >= f.expires)
    };
    if expired {
        flows().lock().unwrap().remove(flow_id);
        return Ok(Poll::Expired);
    }
    let v = post_form(
        http,
        &url,
        &[
            ("client_id", client_id.as_str()),
            ("device_code", device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ],
    )
    .await?;
    let token = s(&v, "access_token");
    if !token.is_empty() {
        flows().lock().unwrap().remove(flow_id);
        return Ok(Poll::Token { kind, base, token });
    }
    let interval = v.get("interval").and_then(|x| x.as_u64()).unwrap_or(5);
    match s(&v, "error").as_str() {
        "authorization_pending" => Ok(Poll::Pending(interval)),
        "slow_down" => Ok(Poll::Pending(interval + 5)),
        "access_denied" => {
            flows().lock().unwrap().remove(flow_id);
            Ok(Poll::Denied)
        }
        "expired_token" => {
            flows().lock().unwrap().remove(flow_id);
            Ok(Poll::Expired)
        }
        other => Err(AppError::Http(crate::trf!(
            "로그인 확인 실패: {other} {d}",
            "Sign-in check failed: {other} {d}",
            d = s(&v, "error_description")
        ))),
    }
}

/// Forget a flow the user cancelled.
pub fn cancel(flow_id: &str) {
    flows().lock().unwrap().remove(flow_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    type Seen = Arc<Mutex<Vec<(String, String)>>>;

    /// Minimal OAuth server: answers each request with the next canned JSON and records the form bodies.
    fn server(responses: Vec<(u16, Value)>) -> (String, Seen) {
        let srv = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = srv.server_addr().to_ip().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for (code, body) in responses {
                let Ok(mut req) = srv.recv() else { return };
                let mut text = String::new();
                let _ = req.as_reader().read_to_string(&mut text);
                log.lock().unwrap().push((req.url().to_string(), text));
                let _ = req.respond(tiny_http::Response::from_string(body.to_string()).with_status_code(code));
            }
        });
        (format!("http://127.0.0.1:{port}"), seen)
    }

    #[test]
    fn github_device_flow_pending_slow_down_then_token() {
        let (base, seen) = server(vec![
            (
                200,
                serde_json::json!({"device_code":"dev123","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}),
            ),
            (200, serde_json::json!({"error":"authorization_pending"})),
            (200, serde_json::json!({"error":"slow_down","interval":10})),
            (200, serde_json::json!({"access_token":"gho_secret","token_type":"bearer","scope":"repo"})),
        ]);
        let http = reqwest::Client::new();
        tauri::async_runtime::block_on(async {
            let st = start(&http, ForgeKind::Github, &base, "client-1").await.unwrap();
            assert_eq!(st.user_code, "ABCD-1234");
            assert_eq!(st.interval, 5);
            assert_eq!(poll(&http, &st.flow_id).await.unwrap(), Poll::Pending(5));
            assert_eq!(poll(&http, &st.flow_id).await.unwrap(), Poll::Pending(15));
            match poll(&http, &st.flow_id).await.unwrap() {
                Poll::Token { token, kind, .. } => assert_eq!((token.as_str(), kind), ("gho_secret", ForgeKind::Github)),
                other => panic!("{other:?}"),
            }
            // the flow is forgotten after success
            assert!(poll(&http, &st.flow_id).await.is_err());
        });
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].0, "/login/device/code");
        assert!(seen[0].1.contains("client_id=client-1") && seen[0].1.contains("scope=repo+read%3Aorg"));
        assert_eq!(seen[1].0, "/login/oauth/access_token");
        assert!(seen[1].1.contains("device_code=dev123") && seen[1].1.contains("grant_type=urn%3Aietf"));
    }

    #[test]
    fn gitlab_device_flow_reports_denial() {
        let (base, seen) = server(vec![
            (
                200,
                serde_json::json!({"device_code":"d","user_code":"WXYZ","verification_uri":"https://gitlab.example/oauth/device","verification_uri_complete":"https://gitlab.example/oauth/device?user_code=WXYZ","expires_in":300,"interval":5}),
            ),
            (400, serde_json::json!({"error":"access_denied"})),
        ]);
        let http = reqwest::Client::new();
        tauri::async_runtime::block_on(async {
            let st = start(&http, ForgeKind::Gitlab, &base, "gl").await.unwrap();
            assert!(st.verification_uri_complete.unwrap().ends_with("user_code=WXYZ"));
            assert_eq!(poll(&http, &st.flow_id).await.unwrap(), Poll::Denied);
        });
        assert_eq!(seen.lock().unwrap()[0].0, "/oauth/authorize_device");
        assert_eq!(seen.lock().unwrap()[1].0, "/oauth/token");
    }

    #[test]
    fn disabled_device_flow_is_explained() {
        let (base, _) = server(vec![(200, serde_json::json!({"error":"device_flow_disabled"}))]);
        let http = reqwest::Client::new();
        let err = tauri::async_runtime::block_on(start(&http, ForgeKind::Github, &base, "x")).unwrap_err().to_string();
        assert!(err.contains("Device Flow"), "{err}");
    }

    #[test]
    fn picks_the_client_id() {
        let mut cfg = HashMap::new();
        assert_eq!(client_id(ForgeKind::Github, "https://github.com", &cfg).as_deref(), Some(GITHUB_CLIENT_ID));
        assert_eq!(client_id(ForgeKind::Github, "https://ghe.example.com", &cfg), None);
        assert_eq!(client_id(ForgeKind::Gitea, "https://gitea.com", &cfg), None);
        cfg.insert("ghe.example.com".into(), " abc ".into());
        assert_eq!(client_id(ForgeKind::Github, "ghe.example.com/", &cfg).as_deref(), Some("abc"));
    }
}
