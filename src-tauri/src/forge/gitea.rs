//! Gitea / Forgejo (incl. Codeberg) REST v1.

use reqwest::Method;
use serde_json::{json, Value};

use super::{b, comment_from, opt_s, s, u, Comment, ForgeClient, MergeRequestOptions, NewPullRequest, PullRequest};
use crate::error::AppResult;

pub(super) fn map_pr(v: &Value) -> PullRequest {
    let head = v.get("head").cloned().unwrap_or(Value::Null);
    let base = v.get("base").cloned().unwrap_or(Value::Null);
    let user = v.get("user").cloned().unwrap_or(Value::Null);
    let head_repo = head.get("repo").and_then(|r| r.get("full_name")).and_then(Value::as_str).map(String::from);
    let base_repo = base.get("repo").and_then(|r| r.get("full_name")).and_then(Value::as_str).map(String::from);
    let merged = b(v, "merged");
    let title = s(v, "title");
    PullRequest {
        number: u(v, "number").unwrap_or(0),
        draft: b(v, "draft") || title.starts_with("WIP:") || title.starts_with("[WIP]"),
        title,
        body: s(v, "body"),
        state: if merged { "merged".into() } else { s(v, "state") },
        author: s(&user, "login"),
        author_avatar: opt_s(&user, "avatar_url"),
        // Merged PRs whose branch was deleted report `refs/pull/N/head`; the label keeps the name.
        source_branch: {
            let r = s(&head, "ref");
            if r.starts_with("refs/") {
                opt_s(&head, "label").unwrap_or(r)
            } else {
                r
            }
        },
        target_branch: s(&base, "ref"),
        is_fork: head_repo.is_some() && base_repo.is_some() && head_repo != base_repo,
        source_repo: head_repo,
        head_sha: opt_s(&head, "sha"),
        url: s(v, "html_url"),
        created_at: s(v, "created_at"),
        updated_at: s(v, "updated_at"),
        labels: v.get("labels").and_then(Value::as_array).map(|a| a.iter().map(|l| s(l, "name")).collect()).unwrap_or_default(),
        comments: u(v, "comments"),
        mergeable: v.get("mergeable").and_then(Value::as_bool),
        merge_status: None,
        additions: u(v, "additions"),
        deletions: u(v, "deletions"),
        changed_files: u(v, "changed_files"),
        commits: None,
    }
}

pub(super) async fn list(c: &ForgeClient, repo: &str, state: &str) -> AppResult<Vec<PullRequest>> {
    let st = match state {
        "closed" | "merged" => "closed",
        "all" => "all",
        _ => "open",
    };
    let v = c.send(Method::GET, &format!("/repos/{repo}/pulls?state={st}&limit=50&sort=recentupdate"), None).await?;
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
    let title = if req.draft && !req.title.starts_with("WIP:") { format!("WIP: {}", req.title) } else { req.title.clone() };
    let body = json!({
        "title": title,
        "body": req.body,
        "head": req.source_branch,
        "base": req.target_branch,
    });
    let v = c.send(Method::POST, &format!("/repos/{repo}/pulls"), Some(body)).await?;
    Ok(map_pr(&v))
}

pub(super) async fn merge(c: &ForgeClient, repo: &str, number: u64, o: &MergeRequestOptions) -> AppResult<String> {
    let action = match o.method.as_str() {
        "squash" => "squash",
        "rebase" => "rebase",
        "rebase-merge" => "rebase-merge",
        _ => "merge",
    };
    let mut body = json!({ "Do": action, "delete_branch_after_merge": o.delete_branch });
    if let Some(t) = o.commit_title.as_ref().filter(|t| !t.trim().is_empty()) {
        body["MergeTitleField"] = json!(t);
    }
    if let Some(sha) = o.expected_head_sha.as_ref().filter(|s| !s.is_empty()) {
        body["head_commit_id"] = json!(sha);
    }
    if let Some(m) = o.commit_message.as_ref().filter(|t| !t.trim().is_empty()) {
        body["MergeMessageField"] = json!(m);
    }
    c.send(Method::POST, &format!("/repos/{repo}/pulls/{number}/merge"), Some(body)).await?;
    Ok(crate::trf!("PR #{number} 병합 완료", "PR #{number} merged"))
}

pub(super) async fn close(c: &ForgeClient, repo: &str, number: u64) -> AppResult<()> {
    c.send(Method::PATCH, &format!("/repos/{repo}/pulls/{number}"), Some(json!({ "state": "closed" }))).await?;
    Ok(())
}

pub(super) async fn comments(c: &ForgeClient, repo: &str, number: u64) -> AppResult<Vec<Comment>> {
    let v = c.send(Method::GET, &format!("/repos/{repo}/issues/{number}/comments"), None).await?;
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
    fn maps_gitea_pull_json() {
        let v = json!({
            "number": 3, "title": "WIP: pod sync", "body": "b", "state": "closed", "merged": true,
            "user": {"login": "dolphin"},
            "head": {"ref": "sync", "sha": "s1", "repo": {"full_name": "pod/app"}},
            "base": {"ref": "main", "repo": {"full_name": "pod/app"}},
            "html_url": "http://localhost:3000/pod/app/pulls/3", "mergeable": true, "comments": 1
        });
        let pr = map_pr(&v);
        assert_eq!(pr.state, "merged");
        assert!(pr.draft);
        assert!(!pr.is_fork);
        assert_eq!(pr.mergeable, Some(true));
    }
}
