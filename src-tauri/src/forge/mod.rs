//! Forge (code hosting) integrations: GitHub, GitLab and Gitea/Forgejo.
//!
//! All network calls happen in Rust so tokens never reach the webview and
//! CORS does not apply. Each provider maps its JSON into the shared
//! [`PullRequest`] / [`Comment`] shapes.

mod gitea;
mod github;
mod gitlab;
pub mod oauth;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ForgeKind {
    Github,
    Gitlab,
    Gitea,
}

impl ForgeKind {
    pub fn label(self) -> &'static str {
        match self {
            ForgeKind::Github => "GitHub",
            ForgeKind::Gitlab => "GitLab",
            ForgeKind::Gitea => "Gitea",
        }
    }

    /// Ref that holds the head of review `number` on the remote.
    pub fn review_ref(self, number: u64) -> String {
        match self {
            ForgeKind::Github | ForgeKind::Gitea => format!("refs/pull/{number}/head"),
            ForgeKind::Gitlab => format!("refs/merge-requests/{number}/head"),
        }
    }

    pub fn review_branch(self, number: u64) -> String {
        match self {
            ForgeKind::Gitlab => format!("mr/{number}"),
            _ => format!("pr/{number}"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub kind: ForgeKind,
    /// Web base URL, e.g. `https://github.com` or `https://git.example.com:3000`.
    pub base_url: String,
    pub username: Option<String>,
    pub avatar_url: Option<String>,
    /// Optional API base override (useful for unusual reverse proxies).
    pub api_url: Option<String>,
}

impl Account {
    pub fn host(&self) -> String {
        host_of(&self.base_url)
    }
}

pub fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let rest = rest.rsplit_once('@').map(|(_, r)| r).unwrap_or(rest);
    rest.split('/').next().unwrap_or_default().to_ascii_lowercase()
}

pub fn normalize_base(url: &str) -> String {
    let url = url.trim().trim_end_matches('/');
    if url.contains("://") {
        url.to_string()
    } else {
        format!("https://{url}")
    }
}

pub fn api_base(kind: ForgeKind, base_url: &str) -> String {
    let base = normalize_base(base_url);
    match kind {
        ForgeKind::Github => {
            if host_of(&base) == "github.com" {
                "https://api.github.com".into()
            } else {
                format!("{base}/api/v3")
            }
        }
        ForgeKind::Gitlab => format!("{base}/api/v4"),
        ForgeKind::Gitea => format!("{base}/api/v1"),
    }
}

/// A remote URL split into host and repository path.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTarget {
    /// Host (and port for http remotes) used to match accounts.
    pub host: String,
    /// Web base URL guessed from the remote.
    pub web_base: String,
    /// Full repository path, e.g. `owner/repo` or `group/sub/repo`.
    pub path: String,
    pub owner: String,
    pub name: String,
}

pub fn parse_remote_url(url: &str) -> Option<RemoteTarget> {
    let url = url.trim();
    let (scheme, host_port, path) = if let Some((scheme, rest)) = url.split_once("://") {
        let rest = rest.rsplit_once('@').map(|(_, r)| r).unwrap_or(rest);
        let (hp, path) = rest.split_once('/')?;
        (scheme.to_ascii_lowercase(), hp.to_string(), path.to_string())
    } else if let Some((left, path)) = url.split_once(':') {
        // scp-like syntax: [user@]host:path — but not a Windows drive letter.
        if left.len() <= 1 || left.contains('/') {
            return None;
        }
        let host = left.rsplit_once('@').map(|(_, h)| h).unwrap_or(left);
        ("ssh".to_string(), host.to_string(), path.to_string())
    } else {
        return None;
    };
    if scheme == "file" {
        return None;
    }
    let host_only = host_port.split(':').next().unwrap_or_default().to_ascii_lowercase();
    let (web_base, host) = if scheme == "http" || scheme == "https" {
        (format!("{scheme}://{}", host_port.to_ascii_lowercase()), host_port.to_ascii_lowercase())
    } else {
        (format!("https://{host_only}"), host_only.clone())
    };
    let path = path.trim_matches('/').trim_end_matches(".git").trim_matches('/').to_string();
    let (owner, name) = path.rsplit_once('/')?;
    if owner.is_empty() || name.is_empty() {
        return None;
    }
    Some(RemoteTarget { host, web_base, owner: owner.to_string(), name: name.to_string(), path })
}

/// Provider guess for a host when the user has not configured an account.
pub fn guess_kind(host: &str) -> Option<ForgeKind> {
    let h = host.split(':').next().unwrap_or(host);
    match h {
        "github.com" => Some(ForgeKind::Github),
        "gitlab.com" => Some(ForgeKind::Gitlab),
        "gitea.com" | "codeberg.org" => Some(ForgeKind::Gitea),
        _ if h.contains("github") => Some(ForgeKind::Github),
        _ if h.contains("gitlab") => Some(ForgeKind::Gitlab),
        _ if h.contains("gitea") || h.contains("forgejo") || h.contains("codeberg") => Some(ForgeKind::Gitea),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub body: String,
    /// `open`, `closed` or `merged`.
    pub state: String,
    pub draft: bool,
    pub author: String,
    pub author_avatar: Option<String>,
    pub source_branch: String,
    pub target_branch: String,
    pub source_repo: Option<String>,
    pub is_fork: bool,
    pub head_sha: Option<String>,
    pub url: String,
    pub created_at: String,
    pub updated_at: String,
    pub labels: Vec<String>,
    pub comments: Option<u64>,
    pub mergeable: Option<bool>,
    pub merge_status: Option<String>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub changed_files: Option<u64>,
    pub commits: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub author: String,
    pub author_avatar: Option<String>,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPullRequest {
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub source_branch: String,
    pub target_branch: String,
    #[serde(default)]
    pub draft: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequestOptions {
    /// `merge`, `squash` or `rebase`.
    pub method: String,
    pub commit_title: Option<String>,
    pub commit_message: Option<String>,
    #[serde(default)]
    pub delete_branch: bool,
    /// Head commit the user reviewed; the forge refuses the merge if the PR moved since.
    #[serde(default)]
    pub expected_head_sha: Option<String>,
}

/// A repository the signed-in account can reach.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ForgeRepo {
    pub full_name: String,
    pub name: String,
    pub owner: String,
    pub description: String,
    pub private: bool,
    pub fork: bool,
    pub archived: bool,
    pub default_branch: Option<String>,
    pub clone_https: String,
    pub clone_ssh: String,
    pub web_url: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewer {
    pub username: String,
    pub avatar_url: Option<String>,
    pub name: Option<String>,
}

/// One authenticated (or anonymous) connection to a forge API.
pub struct ForgeClient {
    pub kind: ForgeKind,
    pub api: String,
    pub token: Option<String>,
    pub http: reqwest::Client,
}

pub(crate) fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

pub(crate) fn opt_s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(String::from).filter(|s| !s.is_empty())
}

pub(crate) fn u(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(Value::as_u64)
}

pub(crate) fn b(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

impl ForgeClient {
    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let url = format!("{}{}", self.api, path);
        let accept = if self.kind == ForgeKind::Github { "application/vnd.github+json" } else { "application/json" };
        let mut rb = self.http.request(method, url).header("Accept", accept);
        if let Some(t) = &self.token {
            rb = match self.kind {
                ForgeKind::Github => {
                    rb.header("Authorization", format!("Bearer {t}")).header("X-GitHub-Api-Version", "2022-11-28")
                }
                ForgeKind::Gitlab => rb.header("PRIVATE-TOKEN", t),
                ForgeKind::Gitea => rb.header("Authorization", format!("token {t}")),
            };
        }
        rb
    }

    pub(crate) async fn send(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> AppResult<Value> {
        let mut rb = self.request(method, path);
        if let Some(body) = body {
            rb = rb.json(&body);
        }
        let resp = rb
            .send()
            .await
            .map_err(|e| AppError::Http(crate::trf!("{} 연결 실패: {e}", "Could not reach {}: {e}", self.kind.label())))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            let parsed: Option<Value> = serde_json::from_str(&text).ok();
            let msg = parsed
                .as_ref()
                .and_then(|v| {
                    v.get("message").or_else(|| v.get("error")).map(|m| {
                        if let Some(s) = m.as_str() {
                            s.to_string()
                        } else {
                            m.to_string()
                        }
                    })
                })
                .unwrap_or_else(|| text.chars().take(300).collect());
            let hint = match status.as_u16() {
                401 => crate::tr!(
                    " — 토큰이 없거나 만료되었습니다. 계정 설정을 확인하세요.",
                    " — the token is missing or expired. Check the account settings."
                ),
                403 => crate::tr!(
                    " — 권한이 부족하거나 API 호출 한도를 넘었습니다.",
                    " — insufficient permissions or the API rate limit was exceeded."
                ),
                404 => crate::tr!(
                    " — 저장소를 찾을 수 없습니다(비공개 저장소라면 토큰이 필요합니다).",
                    " — repository not found (private repositories need a token)."
                ),
                _ => "",
            };
            return Err(AppError::Http(format!("{} {}: {msg}{hint}", self.kind.label(), status.as_u16())));
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        Ok(serde_json::from_str(&text)?)
    }

    /// Whether this connection can see the repository at `path` (`owner/repo`);
    /// `None` when the service could not be asked or gave no clear answer.
    pub async fn can_see(&self, path: &str) -> Option<bool> {
        let route = match self.kind {
            ForgeKind::Gitlab => format!("/projects/{}", urlencoding::encode(path)),
            ForgeKind::Github | ForgeKind::Gitea => format!("/repos/{path}"),
        };
        let status = self.request(reqwest::Method::GET, &route).send().await.ok()?.status();
        match status.as_u16() {
            200..=299 => Some(true),
            401 | 403 | 404 => Some(false),
            _ => None,
        }
    }

    pub async fn viewer(&self) -> AppResult<Viewer> {
        let v = self.send(reqwest::Method::GET, "/user", None).await?;
        let username = match self.kind {
            ForgeKind::Gitlab => s(&v, "username"),
            ForgeKind::Gitea => {
                let l = s(&v, "login");
                if l.is_empty() {
                    s(&v, "username")
                } else {
                    l
                }
            }
            ForgeKind::Github => s(&v, "login"),
        };
        Ok(Viewer { username, avatar_url: opt_s(&v, "avatar_url"), name: opt_s(&v, "name").or_else(|| opt_s(&v, "full_name")) })
    }

    /// Repositories the account owns, collaborates on or reaches through an organisation/group.
    pub async fn repos(&self) -> AppResult<Vec<ForgeRepo>> {
        let mut out: Vec<ForgeRepo> = Vec::new();
        match self.kind {
            ForgeKind::Github => {
                // every page (capped far above any real account) so "all repositories" means all
                for page in 1..=200 {
                    let v = self
                        .send(
                            reqwest::Method::GET,
                            &format!("/user/repos?per_page=100&page={page}&sort=updated&affiliation=owner,collaborator,organization_member"),
                            None,
                        )
                        .await?;
                    let batch = v.as_array().cloned().unwrap_or_default();
                    out.extend(batch.iter().map(github_repo));
                    if batch.len() < 100 {
                        break;
                    }
                }
            }
            ForgeKind::Gitlab => {
                for page in 1..=200 {
                    let v = self
                        .send(
                            reqwest::Method::GET,
                            &format!("/projects?membership=true&per_page=100&page={page}&order_by=last_activity_at&sort=desc"),
                            None,
                        )
                        .await?;
                    let batch = v.as_array().cloned().unwrap_or_default();
                    out.extend(batch.iter().map(gitlab_repo));
                    if batch.len() < 100 {
                        break;
                    }
                }
            }
            ForgeKind::Gitea => {
                for page in 1..=400 {
                    let v = self.send(reqwest::Method::GET, &format!("/user/repos?limit=50&page={page}"), None).await?;
                    let batch = v.as_array().cloned().unwrap_or_default();
                    out.extend(batch.iter().map(gitea_repo));
                    if batch.len() < 50 {
                        break;
                    }
                }
                // Organisation repositories are not part of /user/repos on Gitea.
                if let Ok(orgs) = self.send(reqwest::Method::GET, "/user/orgs?limit=50", None).await {
                    for org in orgs.as_array().cloned().unwrap_or_default() {
                        let name = s(&org, "username");
                        if name.is_empty() {
                            continue;
                        }
                        for page in 1..=400 {
                            let Ok(v) =
                                self.send(reqwest::Method::GET, &format!("/orgs/{name}/repos?limit=50&page={page}"), None).await
                            else {
                                break;
                            };
                            let batch = v.as_array().cloned().unwrap_or_default();
                            for r in &batch {
                                let repo = gitea_repo(r);
                                if !out.iter().any(|x| x.full_name == repo.full_name) {
                                    out.push(repo);
                                }
                            }
                            if batch.len() < 50 {
                                break;
                            }
                        }
                    }
                }
            }
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    pub async fn list(&self, repo: &str, state: &str) -> AppResult<Vec<PullRequest>> {
        match self.kind {
            ForgeKind::Github => github::list(self, repo, state).await,
            ForgeKind::Gitlab => gitlab::list(self, repo, state).await,
            ForgeKind::Gitea => gitea::list(self, repo, state).await,
        }
    }

    pub async fn get(&self, repo: &str, number: u64) -> AppResult<PullRequest> {
        match self.kind {
            ForgeKind::Github => github::get(self, repo, number).await,
            ForgeKind::Gitlab => gitlab::get(self, repo, number).await,
            ForgeKind::Gitea => gitea::get(self, repo, number).await,
        }
    }

    pub async fn create(&self, repo: &str, req: &NewPullRequest) -> AppResult<PullRequest> {
        if req.title.trim().is_empty() {
            return Err(AppError::invalid(crate::tr!("제목을 입력하세요", "Enter a title")));
        }
        if req.source_branch == req.target_branch {
            return Err(AppError::invalid(crate::tr!(
                "원본과 대상 브랜치가 같습니다",
                "Source and target branches are the same"
            )));
        }
        match self.kind {
            ForgeKind::Github => github::create(self, repo, req).await,
            ForgeKind::Gitlab => gitlab::create(self, repo, req).await,
            ForgeKind::Gitea => gitea::create(self, repo, req).await,
        }
    }

    pub async fn merge(&self, repo: &str, number: u64, opts: &MergeRequestOptions) -> AppResult<String> {
        match self.kind {
            ForgeKind::Github => github::merge(self, repo, number, opts).await,
            ForgeKind::Gitlab => gitlab::merge(self, repo, number, opts).await,
            ForgeKind::Gitea => gitea::merge(self, repo, number, opts).await,
        }
    }

    pub async fn close(&self, repo: &str, number: u64) -> AppResult<()> {
        match self.kind {
            ForgeKind::Github => github::close(self, repo, number).await,
            ForgeKind::Gitlab => gitlab::close(self, repo, number).await,
            ForgeKind::Gitea => gitea::close(self, repo, number).await,
        }
    }

    pub async fn comments(&self, repo: &str, number: u64) -> AppResult<Vec<Comment>> {
        match self.kind {
            ForgeKind::Github => github::comments(self, repo, number).await,
            ForgeKind::Gitlab => gitlab::comments(self, repo, number).await,
            ForgeKind::Gitea => gitea::comments(self, repo, number).await,
        }
    }

    pub async fn add_comment(&self, repo: &str, number: u64, body: &str) -> AppResult<Comment> {
        if body.trim().is_empty() {
            return Err(AppError::invalid(crate::tr!("댓글 내용을 입력하세요", "Enter a comment")));
        }
        match self.kind {
            ForgeKind::Github => github::add_comment(self, repo, number, body).await,
            ForgeKind::Gitlab => gitlab::add_comment(self, repo, number, body).await,
            ForgeKind::Gitea => gitea::add_comment(self, repo, number, body).await,
        }
    }
}

fn github_repo(v: &Value) -> ForgeRepo {
    let owner = v.get("owner").map(|o| s(o, "login")).unwrap_or_default();
    ForgeRepo {
        full_name: s(v, "full_name"),
        name: s(v, "name"),
        owner,
        description: s(v, "description"),
        private: b(v, "private"),
        fork: b(v, "fork"),
        archived: b(v, "archived"),
        default_branch: opt_s(v, "default_branch"),
        clone_https: s(v, "clone_url"),
        clone_ssh: s(v, "ssh_url"),
        web_url: s(v, "html_url"),
        updated_at: opt_s(v, "pushed_at").unwrap_or_else(|| s(v, "updated_at")),
    }
}

fn gitlab_repo(v: &Value) -> ForgeRepo {
    let ns = v.get("namespace").cloned().unwrap_or(Value::Null);
    ForgeRepo {
        full_name: s(v, "path_with_namespace"),
        name: s(v, "path"),
        owner: opt_s(&ns, "full_path").unwrap_or_else(|| s(&ns, "path")),
        description: s(v, "description"),
        private: s(v, "visibility") != "public",
        fork: v.get("forked_from_project").is_some_and(|f| !f.is_null()),
        archived: b(v, "archived"),
        default_branch: opt_s(v, "default_branch"),
        clone_https: s(v, "http_url_to_repo"),
        clone_ssh: s(v, "ssh_url_to_repo"),
        web_url: s(v, "web_url"),
        updated_at: s(v, "last_activity_at"),
    }
}

fn gitea_repo(v: &Value) -> ForgeRepo {
    let owner = v.get("owner").map(|o| s(o, "login")).unwrap_or_default();
    ForgeRepo {
        full_name: s(v, "full_name"),
        name: s(v, "name"),
        owner,
        description: s(v, "description"),
        private: b(v, "private"),
        fork: b(v, "fork"),
        archived: b(v, "archived"),
        default_branch: opt_s(v, "default_branch"),
        clone_https: s(v, "clone_url"),
        clone_ssh: s(v, "ssh_url"),
        web_url: s(v, "html_url"),
        updated_at: s(v, "updated_at"),
    }
}

pub(crate) fn comment_from(v: &Value, user_key: &str, login_key: &str) -> Comment {
    let user = v.get(user_key).cloned().unwrap_or(Value::Null);
    Comment {
        id: v.get("id").map(|i| i.to_string()).unwrap_or_default(),
        author: s(&user, login_key),
        author_avatar: opt_s(&user, "avatar_url"),
        body: s(v, "body"),
        created_at: s(v, "created_at"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_remote_urls() {
        let r = parse_remote_url("git@github.com:mobyd/app.git").unwrap();
        assert_eq!((r.host.as_str(), r.owner.as_str(), r.name.as_str()), ("github.com", "mobyd", "app"));
        assert_eq!(r.web_base, "https://github.com");

        let r = parse_remote_url("https://gitlab.com/group/sub/project.git").unwrap();
        assert_eq!(r.path, "group/sub/project");
        assert_eq!(r.owner, "group/sub");

        let r = parse_remote_url("http://user:pw@localhost:3000/me/repo").unwrap();
        assert_eq!(r.host, "localhost:3000");
        assert_eq!(r.web_base, "http://localhost:3000");

        let r = parse_remote_url("ssh://git@git.example.com:2222/team/repo.git").unwrap();
        assert_eq!(r.host, "git.example.com");
        assert_eq!(r.web_base, "https://git.example.com");

        assert!(parse_remote_url("/local/path/repo.git").is_none());
        assert!(parse_remote_url("C:\\repos\\x").is_none());
        assert!(parse_remote_url("file:///tmp/repo").is_none());
    }

    #[test]
    fn api_bases() {
        assert_eq!(api_base(ForgeKind::Github, "https://github.com"), "https://api.github.com");
        assert_eq!(api_base(ForgeKind::Github, "ghe.corp.io"), "https://ghe.corp.io/api/v3");
        assert_eq!(api_base(ForgeKind::Gitlab, "https://gitlab.com/"), "https://gitlab.com/api/v4");
        assert_eq!(api_base(ForgeKind::Gitea, "http://localhost:3000"), "http://localhost:3000/api/v1");
    }

    #[test]
    fn guesses_kinds() {
        assert_eq!(guess_kind("github.com"), Some(ForgeKind::Github));
        assert_eq!(guess_kind("codeberg.org"), Some(ForgeKind::Gitea));
        assert_eq!(guess_kind("gitlab.example.com"), Some(ForgeKind::Gitlab));
        assert_eq!(guess_kind("example.com"), None);
    }

    #[test]
    fn review_refs() {
        assert_eq!(ForgeKind::Github.review_ref(7), "refs/pull/7/head");
        assert_eq!(ForgeKind::Gitlab.review_ref(7), "refs/merge-requests/7/head");
        assert_eq!(ForgeKind::Gitlab.review_branch(7), "mr/7");
    }
}

#[cfg(test)]
mod http_tests {
    //! Drive every write operation against a local mock server and check the
    //! exact method, path, auth header and JSON body each provider receives.
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Debug, Clone)]
    struct Seen {
        method: String,
        url: String,
        auth: Option<String>,
        body: Value,
    }

    fn mock(responses: Vec<(u16, Value)>) -> (String, Arc<Mutex<Vec<Seen>>>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for (code, body) in responses {
                let Ok(mut req) = server.recv() else { return };
                let mut text = String::new();
                let _ = req.as_reader().read_to_string(&mut text);
                let auth =
                    req.headers().iter().find(|h| h.field.equiv("Authorization") || h.field.equiv("PRIVATE-TOKEN")).map(|h| {
                        format!(
                            "{}: {}",
                            h.field.as_str().as_str().to_ascii_uppercase().replace("AUTHORIZATION", "Authorization"),
                            h.value
                        )
                    });
                log.lock().unwrap().push(Seen {
                    method: req.method().to_string(),
                    url: req.url().to_string(),
                    auth,
                    body: serde_json::from_str(&text).unwrap_or(Value::Null),
                });
                let _ = req.respond(tiny_http::Response::from_string(body.to_string()).with_status_code(code));
            }
        });
        (format!("http://127.0.0.1:{port}"), seen)
    }

    fn client(kind: ForgeKind, api: String) -> ForgeClient {
        ForgeClient { kind, api, token: Some("t0k".into()), http: reqwest::Client::new() }
    }

    fn pr_json(number: u64) -> Value {
        serde_json::json!({
            "number": number, "iid": number, "title": "Sonar", "state": "open",
            "head": {"ref": "sonar", "repo": {"full_name": "pod/app"}}, "base": {"ref": "main", "repo": {"full_name": "pod/app"}},
            "source_branch": "sonar", "target_branch": "main", "user": {"login": "flipper"}, "author": {"username": "flipper"}
        })
    }

    use tauri::async_runtime::block_on;

    #[test]
    fn github_write_calls() {
        let (api, seen) = mock(vec![
            (201, pr_json(5)),
            (200, pr_json(5)),
            (200, serde_json::json!({"merged": true, "message": "Pull Request successfully merged"})),
            (204, Value::Null),
            (200, pr_json(5)),
            (201, serde_json::json!({"id": 1, "body": "hi", "user": {"login": "flipper"}, "created_at": "x"})),
        ]);
        let c = client(ForgeKind::Github, api);
        let req = NewPullRequest {
            title: "Sonar".into(),
            body: "b".into(),
            source_branch: "sonar".into(),
            target_branch: "main".into(),
            draft: true,
        };
        assert_eq!(block_on(c.create("pod/app", &req)).unwrap().number, 5);
        let opts = MergeRequestOptions {
            method: "squash".into(),
            commit_title: Some("T".into()),
            commit_message: None,
            delete_branch: true,
            expected_head_sha: Some("abc123".into()),
        };
        block_on(c.merge("pod/app", 5, &opts)).unwrap();
        block_on(c.close("pod/app", 5)).unwrap();
        assert_eq!(block_on(c.add_comment("pod/app", 5, "hi")).unwrap().author, "flipper");
        let s = seen.lock().unwrap().clone();
        assert_eq!((s[0].method.as_str(), s[0].url.as_str()), ("POST", "/repos/pod/app/pulls"));
        assert_eq!(s[0].body["head"], "sonar");
        assert_eq!(s[0].body["draft"], true);
        assert_eq!(s[0].auth.as_deref(), Some("Authorization: Bearer t0k"));
        assert_eq!((s[1].method.as_str(), s[1].url.as_str()), ("GET", "/repos/pod/app/pulls/5"));
        assert_eq!((s[2].method.as_str(), s[2].url.as_str()), ("PUT", "/repos/pod/app/pulls/5/merge"));
        assert_eq!(s[2].body["merge_method"], "squash");
        assert_eq!(s[2].body["commit_title"], "T");
        assert_eq!(s[2].body["sha"], "abc123");
        assert_eq!((s[3].method.as_str(), s[3].url.as_str()), ("DELETE", "/repos/pod/app/git/refs/heads/sonar"));
        assert_eq!((s[4].method.as_str(), s[4].url.as_str()), ("PATCH", "/repos/pod/app/pulls/5"));
        assert_eq!(s[4].body["state"], "closed");
        assert_eq!((s[5].method.as_str(), s[5].url.as_str()), ("POST", "/repos/pod/app/issues/5/comments"));
    }

    #[test]
    fn gitlab_write_calls() {
        let (api, seen) = mock(vec![
            (201, pr_json(9)),
            (200, serde_json::json!({"state": "merged"})),
            (200, pr_json(9)),
            (201, serde_json::json!({"id": 2, "body": "hi", "author": {"username": "orca"}, "created_at": "x"})),
        ]);
        let c = client(ForgeKind::Gitlab, api);
        let req = NewPullRequest {
            title: "Echo".into(),
            body: "d".into(),
            source_branch: "echo".into(),
            target_branch: "main".into(),
            draft: true,
        };
        block_on(c.create("group/sub/app", &req)).unwrap();
        let opts = MergeRequestOptions {
            method: "squash".into(),
            commit_title: None,
            commit_message: Some("msg".into()),
            delete_branch: true,
            expected_head_sha: Some("abc123".into()),
        };
        block_on(c.merge("group/sub/app", 9, &opts)).unwrap();
        block_on(c.close("group/sub/app", 9)).unwrap();
        assert_eq!(block_on(c.add_comment("group/sub/app", 9, "hi")).unwrap().author, "orca");
        let s = seen.lock().unwrap().clone();
        assert_eq!((s[0].method.as_str(), s[0].url.as_str()), ("POST", "/projects/group%2Fsub%2Fapp/merge_requests"));
        assert_eq!(s[0].body["title"], "Draft: Echo");
        assert_eq!(s[0].body["source_branch"], "echo");
        assert_eq!(s[0].auth.as_deref(), Some("PRIVATE-TOKEN: t0k"));
        assert_eq!((s[1].method.as_str(), s[1].url.as_str()), ("PUT", "/projects/group%2Fsub%2Fapp/merge_requests/9/merge"));
        assert_eq!(s[1].body["squash"], true);
        assert_eq!(s[1].body["should_remove_source_branch"], true);
        assert_eq!(s[1].body["squash_commit_message"], "msg");
        assert_eq!(s[1].body["sha"], "abc123");
        assert_eq!(s[2].body["state_event"], "close");
        assert_eq!((s[3].method.as_str(), s[3].url.as_str()), ("POST", "/projects/group%2Fsub%2Fapp/merge_requests/9/notes"));
    }

    #[test]
    fn gitea_write_calls_and_errors() {
        let (api, seen) = mock(vec![
            (201, pr_json(3)),
            (200, Value::Null),
            (201, Value::Null),
            (405, serde_json::json!({"message": "Please try again later"})),
        ]);
        let c = client(ForgeKind::Gitea, api);
        let req = NewPullRequest {
            title: "Pod".into(),
            body: "".into(),
            source_branch: "pod".into(),
            target_branch: "main".into(),
            draft: false,
        };
        block_on(c.create("pod/app", &req)).unwrap();
        block_on(c.close("pod/app", 3)).unwrap();
        let opts = MergeRequestOptions {
            method: "rebase".into(),
            commit_title: None,
            commit_message: None,
            delete_branch: false,
            expected_head_sha: Some("abc123".into()),
        };
        block_on(c.merge("pod/app", 3, &opts)).unwrap();
        let err = block_on(c.merge("pod/app", 3, &opts)).unwrap_err().to_string();
        assert!(err.contains("405") && err.contains("Please try again later"), "{err}");
        let s = seen.lock().unwrap().clone();
        assert_eq!(s[0].auth.as_deref(), Some("Authorization: token t0k"));
        assert_eq!(s[0].body["head"], "pod");
        assert_eq!((s[1].method.as_str(), s[1].url.as_str()), ("PATCH", "/repos/pod/app/pulls/3"));
        assert_eq!((s[2].method.as_str(), s[2].url.as_str()), ("POST", "/repos/pod/app/pulls/3/merge"));
        assert_eq!(s[2].body["Do"], "rebase");
        assert_eq!(s[2].body["delete_branch_after_merge"], false);
        assert_eq!(s[2].body["head_commit_id"], "abc123");
    }

    #[test]
    fn lists_account_repositories_per_provider() {
        let gh = serde_json::json!([{"full_name": "pod/app", "name": "app", "owner": {"login": "pod"}, "private": true,
            "clone_url": "https://github.com/pod/app.git", "ssh_url": "git@github.com:pod/app.git", "html_url": "https://github.com/pod/app",
            "default_branch": "main", "pushed_at": "2026-11-01T00:00:00Z"}]);
        let (api, seen) = mock(vec![(200, gh)]);
        let repos = block_on(client(ForgeKind::Github, api).repos()).unwrap();
        assert_eq!(repos[0].full_name, "pod/app");
        assert!(repos[0].private);
        assert_eq!(repos[0].clone_ssh, "git@github.com:pod/app.git");
        assert!(seen.lock().unwrap()[0].url.starts_with("/user/repos?per_page=100&page=1"));

        let gl = serde_json::json!([{"path_with_namespace": "g/sub/proj", "path": "proj", "namespace": {"full_path": "g/sub"},
            "visibility": "internal", "http_url_to_repo": "https://gitlab.com/g/sub/proj.git", "ssh_url_to_repo": "git@gitlab.com:g/sub/proj.git",
            "web_url": "https://gitlab.com/g/sub/proj", "last_activity_at": "2026-10-01"}]);
        let (api, seen) = mock(vec![(200, gl)]);
        let repos = block_on(client(ForgeKind::Gitlab, api).repos()).unwrap();
        assert_eq!(repos[0].owner, "g/sub");
        assert!(repos[0].private);
        assert!(seen.lock().unwrap()[0].url.starts_with("/projects?membership=true"));

        let gt_user = serde_json::json!([{"full_name": "me/a", "name": "a", "owner": {"login": "me"}, "clone_url": "http://h/me/a.git", "updated_at": "2026-01-01"}]);
        let gt_orgs = serde_json::json!([{"username": "pod"}]);
        let gt_org =
            serde_json::json!([{"full_name": "pod/b", "name": "b", "owner": {"login": "pod"}, "updated_at": "2026-02-01"}]);
        let (api, _) = mock(vec![(200, gt_user), (200, gt_orgs), (200, gt_org)]);
        let repos = block_on(client(ForgeKind::Gitea, api).repos()).unwrap();
        assert_eq!(repos.iter().map(|r| r.full_name.as_str()).collect::<Vec<_>>(), vec!["pod/b", "me/a"]);
    }

    /// `MOBYD_LIVE_JSON_DIR=<dir> cargo test -- --ignored live_` checks the
    /// mappers against payloads saved from the real public APIs (same schema
    /// as the authenticated `/user/repos` and `/projects?membership=true`).
    #[test]
    #[ignore]
    fn live_repository_payloads_map_cleanly() {
        let dir = std::path::PathBuf::from(std::env::var("MOBYD_LIVE_JSON_DIR").expect("MOBYD_LIVE_JSON_DIR"));
        let load = |f: &str| -> Vec<Value> { serde_json::from_str(&std::fs::read_to_string(dir.join(f)).unwrap()).unwrap() };
        for (file, map, host) in [
            ("github.json", github_repo as fn(&Value) -> ForgeRepo, "github.com"),
            ("gitlab.json", gitlab_repo as fn(&Value) -> ForgeRepo, "gitlab.com"),
            ("gitea.json", gitea_repo as fn(&Value) -> ForgeRepo, ""),
        ] {
            let items = load(file);
            assert!(!items.is_empty(), "{file} empty");
            for v in &items {
                let r = map(v);
                assert!(!r.full_name.is_empty() && !r.name.is_empty() && !r.owner.is_empty(), "{file}: {r:?}");
                assert!(r.full_name.ends_with(&r.name), "{file}: {r:?}");
                assert!(r.clone_https.starts_with("https://") && r.clone_https.contains(host), "{file}: {}", r.clone_https);
                assert!(r.clone_ssh.contains('@') || r.clone_ssh.starts_with("ssh://"), "{file}: {}", r.clone_ssh);
                assert!(r.web_url.starts_with("https://"), "{file}: {}", r.web_url);
                assert!(!r.updated_at.is_empty(), "{file}");
                // the URL we would clone resolves back to the same repository path
                let t = parse_remote_url(&r.clone_https).expect("parsable clone url");
                assert_eq!(t.path.to_lowercase(), r.full_name.to_lowercase(), "{file}");
            }
            eprintln!("{file}: {} repositories mapped", items.len());
        }
    }

    #[test]
    fn rejects_invalid_requests_before_calling_out() {
        let c = client(ForgeKind::Github, "http://127.0.0.1:9".into());
        let same = NewPullRequest {
            title: "x".into(),
            body: "".into(),
            source_branch: "main".into(),
            target_branch: "main".into(),
            draft: false,
        };
        assert!(block_on(c.create("o/r", &same)).is_err());
        let untitled = NewPullRequest {
            title: " ".into(),
            body: "".into(),
            source_branch: "a".into(),
            target_branch: "b".into(),
            draft: false,
        };
        assert!(block_on(c.create("o/r", &untitled)).is_err());
        assert!(block_on(c.add_comment("o/r", 1, "  ")).is_err());
    }
}
