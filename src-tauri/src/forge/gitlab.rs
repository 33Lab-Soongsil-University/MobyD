//! GitLab (gitlab.com and self-managed) REST v4 merge requests.

use reqwest::Method;
use serde_json::{json, Value};

use super::{b, comment_from, opt_s, s, u, Comment, ForgeClient, MergeRequestOptions, NewPullRequest, PullRequest};
use crate::error::{AppError, AppResult};

fn project(repo: &str) -> String {
    urlencoding::encode(repo).into_owned()
}

pub(super) fn map_mr(v: &Value) -> PullRequest {
    let author = v.get("author").cloned().unwrap_or(Value::Null);
    let state = match s(v, "state").as_str() {
        "opened" => "open".to_string(),
        "merged" => "merged".to_string(),
        other => {
            if other == "locked" {
                "open".into()
            } else {
                "closed".into()
            }
        }
    };
    let detailed = opt_s(v, "detailed_merge_status").or_else(|| opt_s(v, "merge_status"));
    let mergeable = detailed.as_deref().map(|d| matches!(d, "mergeable" | "can_be_merged"));
    let title = s(v, "title");
    PullRequest {
        number: u(v, "iid").unwrap_or(0),
        draft: b(v, "draft") || b(v, "work_in_progress") || title.starts_with("Draft:"),
        title,
        body: s(v, "description"),
        state,
        author: s(&author, "username"),
        author_avatar: opt_s(&author, "avatar_url"),
        source_branch: s(v, "source_branch"),
        target_branch: s(v, "target_branch"),
        source_repo: None,
        is_fork: u(v, "source_project_id") != u(v, "target_project_id"),
        head_sha: opt_s(v, "sha"),
        url: s(v, "web_url"),
        created_at: s(v, "created_at"),
        updated_at: s(v, "updated_at"),
        labels: v
            .get("labels")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|l| l.as_str().map(String::from).or_else(|| opt_s(l, "name"))).collect())
            .unwrap_or_default(),
        comments: u(v, "user_notes_count"),
        mergeable,
        merge_status: detailed,
        additions: None,
        deletions: None,
        changed_files: v.get("changes_count").and_then(|c| c.as_str()).and_then(|c| c.trim_end_matches('+').parse().ok()),
        commits: None,
    }
}

pub(super) async fn list(c: &ForgeClient, repo: &str, state: &str) -> AppResult<Vec<PullRequest>> {
    let st = match state {
        "closed" => "closed",
        "merged" => "merged",
        "all" => "all",
        _ => "opened",
    };
    let v = c
        .send(
            Method::GET,
            &format!("/projects/{}/merge_requests?state={st}&per_page=50&order_by=updated_at&sort=desc", project(repo)),
            None,
        )
        .await?;
    Ok(v.as_array().map(|a| a.iter().map(map_mr).collect()).unwrap_or_default())
}

pub(super) async fn get(c: &ForgeClient, repo: &str, number: u64) -> AppResult<PullRequest> {
    let v = c.send(Method::GET, &format!("/projects/{}/merge_requests/{number}", project(repo)), None).await?;
    Ok(map_mr(&v))
}

pub(super) async fn create(c: &ForgeClient, repo: &str, req: &NewPullRequest) -> AppResult<PullRequest> {
    let title = if req.draft && !req.title.starts_with("Draft:") { format!("Draft: {}", req.title) } else { req.title.clone() };
    let body = json!({
        "title": title,
        "description": req.body,
        "source_branch": req.source_branch,
        "target_branch": req.target_branch,
    });
    let v = c.send(Method::POST, &format!("/projects/{}/merge_requests", project(repo)), Some(body)).await?;
    Ok(map_mr(&v))
}

pub(super) async fn merge(c: &ForgeClient, repo: &str, number: u64, o: &MergeRequestOptions) -> AppResult<String> {
    if o.method == "rebase" {
        c.send(Method::PUT, &format!("/projects/{}/merge_requests/{number}/rebase", project(repo)), None).await?;
        return Err(AppError::invalid(crate::tr!(
            "GitLab에 리베이스를 요청했습니다. 리베이스가 끝나면 '병합'을 다시 실행하세요.",
            "Asked GitLab to rebase. Run 'Merge' again once the rebase finishes."
        )));
    }
    let mut body = json!({
        "squash": o.method == "squash",
        "should_remove_source_branch": o.delete_branch,
    });
    if let Some(sha) = o.expected_head_sha.as_ref().filter(|s| !s.is_empty()) {
        body["sha"] = json!(sha);
    }
    if let Some(m) = o.commit_message.as_ref().filter(|t| !t.trim().is_empty()) {
        body["merge_commit_message"] = json!(m);
        if o.method == "squash" {
            body["squash_commit_message"] = json!(m);
        }
    }
    let v = c.send(Method::PUT, &format!("/projects/{}/merge_requests/{number}/merge", project(repo)), Some(body)).await?;
    Ok(format!("MR !{} {}", number, s(&v, "state")))
}

pub(super) async fn close(c: &ForgeClient, repo: &str, number: u64) -> AppResult<()> {
    c.send(Method::PUT, &format!("/projects/{}/merge_requests/{number}", project(repo)), Some(json!({ "state_event": "close" })))
        .await?;
    Ok(())
}

pub(super) async fn comments(c: &ForgeClient, repo: &str, number: u64) -> AppResult<Vec<Comment>> {
    let v = c
        .send(
            Method::GET,
            &format!("/projects/{}/merge_requests/{number}/notes?per_page=100&sort=asc&order_by=created_at", project(repo)),
            None,
        )
        .await?;
    Ok(v.as_array()
        .map(|a| a.iter().filter(|n| !b(n, "system")).map(|n| comment_from(n, "author", "username")).collect())
        .unwrap_or_default())
}

pub(super) async fn add_comment(c: &ForgeClient, repo: &str, number: u64, body: &str) -> AppResult<Comment> {
    let v = c
        .send(Method::POST, &format!("/projects/{}/merge_requests/{number}/notes", project(repo)), Some(json!({ "body": body })))
        .await?;
    Ok(comment_from(&v, "author", "username"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_merge_request_json() {
        let v = json!({
            "iid": 4, "title": "Draft: echolocation", "description": "body", "state": "opened",
            "author": {"username": "orca"}, "source_branch": "echo", "target_branch": "main",
            "source_project_id": 1, "target_project_id": 1, "web_url": "https://gitlab.com/g/p/-/merge_requests/4",
            "labels": ["ui"], "detailed_merge_status": "mergeable", "user_notes_count": 5, "changes_count": "12"
        });
        let mr = map_mr(&v);
        assert_eq!(mr.number, 4);
        assert_eq!(mr.state, "open");
        assert!(mr.draft);
        assert!(!mr.is_fork);
        assert_eq!(mr.mergeable, Some(true));
        assert_eq!(mr.changed_files, Some(12));
        assert_eq!(project("group/sub/repo"), "group%2Fsub%2Frepo");
    }
}
