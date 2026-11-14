//! GitHub / GitHub Enterprise REST v3.

use reqwest::Method;
use serde_json::{json, Value};

use super::{b, comment_from, opt_s, s, u, Comment, ForgeClient, MergeRequestOptions, NewPullRequest, PullRequest};
use crate::error::{AppError, AppResult};

pub(super) fn map_pr(v: &Value) -> PullRequest {
    let head = v.get("head").cloned().unwrap_or(Value::Null);
    let base = v.get("base").cloned().unwrap_or(Value::Null);
    let user = v.get("user").cloned().unwrap_or(Value::Null);
    let head_repo = head.get("repo").and_then(|r| r.get("full_name")).and_then(Value::as_str).map(String::from);
    let base_repo = base.get("repo").and_then(|r| r.get("full_name")).and_then(Value::as_str).map(String::from);
    let merged = b(v, "merged") || v.get("merged_at").is_some_and(|m| !m.is_null());
    let state = if merged { "merged".to_string() } else { s(v, "state") };
    PullRequest {
        number: u(v, "number").unwrap_or(0),
        title: s(v, "title"),
        body: s(v, "body"),
        state,
        draft: b(v, "draft"),
        author: s(&user, "login"),
        author_avatar: opt_s(&user, "avatar_url"),
        source_branch: s(&head, "ref"),
        target_branch: s(&base, "ref"),
        is_fork: head_repo.is_some() && head_repo != base_repo,
        source_repo: head_repo,
        head_sha: opt_s(&head, "sha"),
        url: s(v, "html_url"),
        created_at: s(v, "created_at"),
        updated_at: s(v, "updated_at"),
        labels: v.get("labels").and_then(Value::as_array).map(|a| a.iter().map(|l| s(l, "name")).collect()).unwrap_or_default(),
        comments: u(v, "comments").map(|c| c + u(v, "review_comments").unwrap_or(0)),
        mergeable: v.get("mergeable").and_then(Value::as_bool),
        merge_status: opt_s(v, "mergeable_state"),
        additions: u(v, "additions"),
        deletions: u(v, "deletions"),
        changed_files: u(v, "changed_files"),
        commits: u(v, "commits"),
    }
}

pub(super) async fn list(c: &ForgeClient, repo: &str, state: &str) -> AppResult<Vec<PullRequest>> {
    let st = match state {
        "closed" | "merged" => "closed",
        "all" => "all",
        _ => "open",
    };
    let v = c.send(Method::GET, &format!("/repos/{repo}/pulls?state={st}&per_page=50&sort=updated&direction=desc"), None).await?;
    let mut prs: Vec<PullRequest> = v.as_array().map(|a| a.iter().map(map_pr).collect()).unwrap_or_default();
    if state == "merged" {
        prs.retain(|p| p.state == "merged");
    }
    Ok(prs)
}

pub(super) async fn get(c: &ForgeClient, repo: &str, number: u64) -> AppResult<PullRequest> {
    let v = c.send(Method::GET, &format!("/repos/{repo}/pulls/{number}"), None).await?;
    Ok(map_pr(&v))
}

pub(super) async fn create(c: &ForgeClient, repo: &str, req: &NewPullRequest) -> AppResult<PullRequest> {
    let body = json!({
        "title": req.title,
        "body": req.body,
        "head": req.source_branch,
        "base": req.target_branch,
        "draft": req.draft,
    });
    let v = c.send(Method::POST, &format!("/repos/{repo}/pulls"), Some(body)).await?;
    Ok(map_pr(&v))
}

pub(super) async fn merge(c: &ForgeClient, repo: &str, number: u64, o: &MergeRequestOptions) -> AppResult<String> {
    let method = match o.method.as_str() {
        "squash" => "squash",
        "rebase" => "rebase",
        _ => "merge",
    };
    let mut body = json!({ "merge_method": method });
    if let Some(t) = o.commit_title.as_ref().filter(|t| !t.trim().is_empty()) {
        body["commit_title"] = json!(t);
    }
    if let Some(sha) = o.expected_head_sha.as_ref().filter(|s| !s.is_empty()) {
        body["sha"] = json!(sha);
    }
    if let Some(m) = o.commit_message.as_ref().filter(|t| !t.trim().is_empty()) {
        body["commit_message"] = json!(m);
    }
    let pr = get(c, repo, number).await?;
    let v = c.send(Method::PUT, &format!("/repos/{repo}/pulls/{number}/merge"), Some(body)).await?;
    if !b(&v, "merged") {
        return Err(AppError::Http(s(&v, "message")));
    }
    if o.delete_branch && !pr.is_fork && !pr.source_branch.is_empty() {
        let path = format!("/repos/{repo}/git/refs/heads/{}", urlencoding::encode(&pr.source_branch).replace("%2F", "/"));
        let _ = c.send(Method::DELETE, &path, None).await;
    }
    Ok(s(&v, "message"))
}

pub(super) async fn close(c: &ForgeClient, repo: &str, number: u64) -> AppResult<()> {
    c.send(Method::PATCH, &format!("/repos/{repo}/pulls/{number}"), Some(json!({ "state": "closed" }))).await?;
    Ok(())
}

pub(super) async fn comments(c: &ForgeClient, repo: &str, number: u64) -> AppResult<Vec<Comment>> {
    let v = c.send(Method::GET, &format!("/repos/{repo}/issues/{number}/comments?per_page=100"), None).await?;
    Ok(v.as_array().map(|a| a.iter().map(|c| comment_from(c, "user", "login")).collect()).unwrap_or_default())
}

pub(super) async fn add_comment(c: &ForgeClient, repo: &str, number: u64, body: &str) -> AppResult<Comment> {
    let v = c.send(Method::POST, &format!("/repos/{repo}/issues/{number}/comments"), Some(json!({ "body": body }))).await?;
    Ok(comment_from(&v, "user", "login"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_pull_request_json() {
        let v = json!({
            "number": 12, "title": "Add sonar", "body": null, "state": "closed", "draft": false,
            "merged_at": "2026-01-01T00:00:00Z",
            "user": {"login": "flipper", "avatar_url": "https://a/x.png"},
            "head": {"ref": "feature/sonar", "sha": "abc", "repo": {"full_name": "fork/app"}},
            "base": {"ref": "main", "repo": {"full_name": "pod/app"}},
            "html_url": "https://github.com/pod/app/pull/12",
            "labels": [{"name": "enhancement"}], "comments": 2, "review_comments": 1
        });
        let pr = map_pr(&v);
        assert_eq!(pr.state, "merged");
        assert!(pr.is_fork);
        assert_eq!(pr.source_branch, "feature/sonar");
        assert_eq!(pr.labels, vec!["enhancement"]);
        assert_eq!(pr.comments, Some(3));
        assert_eq!(pr.body, "");
    }
}
