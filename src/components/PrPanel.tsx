import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  LogIn,
  MessageSquare,
  Send,
  RefreshCw,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorText } from "../lib/api";
import type { PrComment, PullRequest } from "../lib/types";
import { isoRelative } from "../lib/format";
import { initials } from "../lib/graph";
import { useRepo } from "../repo/RepoContext";
import { ask, confirmAction, openPrefs, toast } from "../store";
import { Markdown } from "./Markdown";
import { t } from "../lib/i18n";
import { ErrorBox } from "./ErrorBox";
import { tj } from "../lib/i18n-react";

function StateBadge({ pr }: { pr: PullRequest }) {
  if (pr.state === "merged")
    return (
      <span className="pr-state merged">
        <GitMerge size={13} />{" "}{t("병합됨")}</span>
    );
  if (pr.state === "closed")
    return (
      <span className="pr-state closed">
        <GitPullRequestClosed size={13} />{" "}{t("닫힘")}</span>
    );
  if (pr.draft)
    return (
      <span className="pr-state draft">
        <GitPullRequestDraft size={13} />{" "}{t("초안")}</span>
    );
  return (
    <span className="pr-state open">
      <GitPullRequest size={13} />{" "}{t("열림")}</span>
  );
}

function Avatar({ name, url }: { name: string; url: string | null }) {
  const [failed, setFailed] = useState(false);
  if (url && !failed) return <img className="avatar img" src={url} alt="" onError={() => setFailed(true)} referrerPolicy="no-referrer" />;
  return <span className="avatar">{initials(name)}</span>;
}

export function PrPanel() {
  const ctx = useRepo();
  const ref = ctx.pr!;
  const [pr, setPr] = useState<PullRequest | null>(null);
  const [comments, setComments] = useState<PrComment[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [version, setVersion] = useState(0);
  const forge = ctx.forgeRemotes.find((f) => f.remote === ref.remote);
  const term = forge?.kind === "gitlab" ? "MR" : "PR";
  const mark = forge?.kind === "gitlab" ? "!" : "#";

  useEffect(() => {
    let cancel = false;
    setErr(null);
    Promise.all([api.prGet(ctx.path, ref.remote, ref.number), api.prComments(ctx.path, ref.remote, ref.number).catch(() => [])])
      .then(([p, c]) => {
        if (cancel) return;
        setPr(p);
        setComments(c);
      })
      .catch((e) => !cancel && setErr(errorText(e)));
    return () => {
      cancel = true;
    };
  }, [ctx.path, ref.remote, ref.number, version]);

  const refresh = () => {
    setVersion((v) => v + 1);
    ctx.bumpPrs();
  };

  const merge = async () => {
    if (!pr) return;
    const v = await ask({
      title: t("{term} {mark}{number} 병합", { term, mark, number: pr.number }),
      message: (
        <>
          <b>{pr.sourceBranch}</b> → <b>{pr.targetBranch}</b> {t("· 서버({kind})에서 병합합니다.", { kind: forge?.kind })}</>
      ),
      fields: [
        {
          name: "method",
          label: t("병합 방식"),
          type: "select",
          options: [
            { value: "merge", label: t("병합 커밋 만들기") },
            { value: "squash", label: t("스쿼시 후 병합") },
            { value: "rebase", label: t("리베이스 후 병합") },
          ],
        },
        { name: "title", label: t("커밋 제목 (선택)"), placeholder: pr.title },
        { name: "message", label: t("커밋 메시지 (선택)"), type: "textarea" },
        { name: "deleteBranch", label: t("병합 후 원본 브랜치 삭제"), type: "checkbox", value: !pr.isFork },
        { name: "pull", label: t("병합 후 로컬에서 fetch"), type: "checkbox", value: true },
      ],
      confirmLabel: t("병합"),
    });
    if (!v) return;
    const r = await ctx.run(
      t("{term} 병합", { term }),
      () =>
        api.prMerge(ctx.path, ref.remote, pr.number, {
          method: String(v.method) as "merge" | "squash" | "rebase",
          commitTitle: String(v.title || "") || null,
          commitMessage: String(v.message || "") || null,
          deleteBranch: Boolean(v.deleteBranch),
          expectedHeadSha: pr.headSha,
        }),
      { success: (m) => m || t("{term} {mark}{number} 병합 완료", { term, mark, number: pr.number }), reload: false },
    );
    if (r !== undefined && v.pull) await ctx.run("Fetch", () => api.fetch(ctx.path, ref.remote), { quiet: true });
    refresh();
  };

  const close = async () => {
    if (!pr) return;
    if (!(await confirmAction(t("{term} 닫기", { term }), `${mark}${pr.number} ${pr.title}`, t("닫기"), true))) return;
    await ctx.run(t("{term} 닫기", { term }), () => api.prClose(ctx.path, ref.remote, pr.number), { success: t("{term}을(를) 닫았습니다", { term }), reload: false });
    refresh();
  };

  const checkout = async () => {
    if (!pr) return;
    await ctx.run(t("{term} 체크아웃", { term }), () => api.prCheckout(ctx.path, ref.remote, pr.number), {
      success: t("{term} {mark}{number} 을(를) 로컬 브랜치로 체크아웃했습니다", { term, mark, number: pr.number }),
    });
  };

  const send = async () => {
    if (!pr || !draft.trim()) return;
    const c = await ctx.run(t("댓글 달기"), () => api.prAddComment(ctx.path, ref.remote, pr.number, draft), { reload: false, quiet: true });
    if (c) {
      setComments((prev) => [...prev, c]);
      setDraft("");
    }
  };

  if (err)
    return (
      <div className="panel">
        <button className="btn sm ghost back" onClick={() => ctx.selectPr(null)}>
          <ArrowLeft size={13} />{" "}{t("돌아가기")}</button>
        <ErrorBox text={err} />
      </div>
    );
  if (!pr) return <div className="panel-empty muted">{t("불러오는 중…")}</div>;

  const headInGraph = pr.headSha && ctx.rowIndex.has(pr.headSha);
  const canWrite = !!forge?.accountId;
  const needAccount = t("이 작업을 하려면 계정을 연결하세요 (오른쪽 위 사람 아이콘)");

  return (
    <div className="panel pr-panel">
      <div className="panel-head">
        <div className="panel-kicker">
          <button className="icon-btn" onClick={() => ctx.selectPr(null)} title={t("닫기")}>
            <ArrowLeft size={14} />
          </button>
          {term} {mark}
          {pr.number}
          <span className="flex1" />
          <button className="icon-btn" title={t("새로고침")} onClick={refresh}>
            <RefreshCw size={13} />
          </button>
          <button className="icon-btn" title={t("웹에서 열기")} onClick={() => openUrl(pr.url).catch(() => toast.error(t("브라우저를 열 수 없습니다")))}>
            <ExternalLink size={13} />
          </button>
        </div>
        <h2 className="commit-subject">{pr.title}</h2>
        <div className="pr-meta">
          <StateBadge pr={pr} />
          <span className="mono branch-flow">
            {pr.isFork && pr.sourceRepo ? `${pr.sourceRepo}:` : ""}
            {pr.sourceBranch} → {pr.targetBranch}
          </span>
        </div>
        <div className="pr-meta muted tiny">
          <Avatar name={pr.author} url={pr.authorAvatar} /> {pr.author} · {t("{created} 생성 · {updated} 업데이트", { created: isoRelative(pr.createdAt), updated: isoRelative(pr.updatedAt) })}</div>
        {pr.labels.length > 0 && (
          <div className="chip-row">
            {pr.labels.map((l) => (
              <span key={l} className="chip">
                {l}
              </span>
            ))}
          </div>
        )}
        <div className="pr-stats tiny">
          {pr.commits != null && <span>{t("커밋")}{" "}{pr.commits}</span>}
          {pr.changedFiles != null && <span>{t("파일")}{" "}{pr.changedFiles}</span>}
          {pr.additions != null && <span className="green">+{pr.additions}</span>}
          {pr.deletions != null && <span className="red">−{pr.deletions}</span>}
          {pr.state === "open" && (
            <span className={pr.mergeable === false ? "red" : pr.mergeable ? "green" : "muted"}>
              {pr.mergeable === false ? t("충돌 있음 / 병합 불가") : pr.mergeable ? t("병합 가능") : t("병합 가능 여부 확인 중")}
              {pr.mergeStatus ? ` (${pr.mergeStatus})` : ""}
            </span>
          )}
        </div>
      </div>

      <div className="pr-actions">
        {pr.state === "open" && (
          <button
            className="btn primary"
            onClick={merge}
            disabled={pr.mergeable === false || !canWrite}
            title={!canWrite ? needAccount : pr.mergeable === false ? t("충돌이 있거나 병합할 수 없는 상태입니다") : t("{v} 기준으로 병합", { v: pr.headSha?.slice(0, 8) ?? "" })}
          >
            <GitMerge size={14} />{" "}{t("병합")}</button>
        )}
        <button className="btn" onClick={checkout}>
          <LogIn size={14} />{" "}{t("로컬에 체크아웃")}</button>
        {headInGraph && (
          <button className="btn ghost" onClick={() => ctx.jumpTo(pr.headSha!)}>{t("그래프에서 보기")}</button>
        )}
        {pr.state === "open" && (
          <button className="btn ghost danger-text" onClick={close} disabled={!canWrite} title={!canWrite ? needAccount : undefined}>{t("닫기")}</button>
        )}
      </div>

      {!canWrite && (
        <div className="pr-hint tiny">
          {tj("계정 없이 공개 정보만 보고 있습니다. {connect}하면 병합·닫기·댓글을 쓸 수 있습니다.", {
            connect: (
              <button className="link" onClick={() => openPrefs("integrations")}>
                {t("계정 연결")}
              </button>
            ),
          })}
        </div>
      )}

      <div className="pr-body">{pr.body ? <Markdown source={pr.body} /> : <p className="muted">{t("설명이 없습니다.")}</p>}</div>

      <div className="files-head">
        <span>
          <MessageSquare size={13} />{" "}{t("댓글")}{" "}<b>{comments.length}</b>
        </span>
      </div>
      <div className="comments">
        {comments.map((c) => (
          <div key={c.id} className="comment">
            <Avatar name={c.author} url={c.authorAvatar} />
            <div>
              <div className="tiny">
                <strong>{c.author}</strong> <span className="muted">{isoRelative(c.createdAt)}</span>
              </div>
              <Markdown source={c.body} />
            </div>
          </div>
        ))}
      </div>
      <div className="comment-box">
        <textarea
          rows={3}
          placeholder={forge?.accountId ? t("댓글 작성… (⌘Enter로 보내기)") : t("댓글을 달려면 계정을 연결하세요")}
          value={draft}
          disabled={!forge?.accountId}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
          }}
        />
        <button className="btn primary" disabled={!draft.trim() || !forge?.accountId} onClick={send}>
          <Send size={13} />{" "}{t("보내기")}</button>
      </div>
    </div>
  );
}
