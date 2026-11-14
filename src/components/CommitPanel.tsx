import { useEffect, useState } from "react";
import { Copy, GitCommitVertical, GitMerge, Archive, ExternalLink } from "lucide-react";
import { api, errorText } from "../lib/api";
import type { CommitDetail } from "../lib/types";
import { absoluteTime, joinPath, relativeTime } from "../lib/format";
import { initials, laneColor } from "../lib/graph";
import { copyText, revealPath } from "../lib/actions";
import { useRepo } from "../repo/RepoContext";
import { openOnForge } from "../repo/actions";
import { openMenu } from "../store";
import { FileRow } from "./FileList";
import { WhaleMark } from "./Logo";
import { t } from "../lib/i18n";
import { ErrorBox } from "./ErrorBox";

const cache = new Map<string, CommitDetail>();

export function CommitPanel() {
  const ctx = useRepo();
  const sha = ctx.selected;
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!sha) return;
    const key = ctx.path + "@" + sha;
    const isStash = sha.startsWith("stash@");
    const hit = !isStash && cache.get(key);
    if (hit) {
      setDetail(hit);
      setErr(null);
      return;
    }
    let cancel = false;
    setDetail(null);
    api
      .commitDetail(ctx.path, sha)
      .then((d) => {
        if (cancel) return;
        if (!isStash) cache.set(key, d);
        setDetail(d);
        setErr(null);
      })
      .catch((e) => !cancel && setErr(errorText(e)));
    return () => {
      cancel = true;
    };
  }, [ctx.path, sha]);

  if (!sha)
    return (
      <div className="panel-empty">
        <span className="empty-whale"><WhaleMark size={64} /></span>
        <p className="muted">{t("커밋을 선택하세요")}</p>
      </div>
    );
  if (err) return <div className="panel-empty"><ErrorBox text={err} /></div>;
  if (!detail) return <div className="panel-empty muted">{t("불러오는 중…")}</div>;

  const idx = ctx.rowIndex.get(sha);
  const color = idx !== undefined && ctx.data ? laneColor(ctx.data.rows[idx]?.color ?? 0) : "var(--accent)";
  const isStash = sha.startsWith("stash@");
  const refs = ctx.refIndex.get(detail.hash) ?? [];
  const additions = detail.files.reduce((n, f) => n + (f.additions ?? 0), 0);
  const deletions = detail.files.reduce((n, f) => n + (f.deletions ?? 0), 0);

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-kicker">
          {isStash ? <Archive size={13} /> : detail.parents.length > 1 ? <GitMerge size={13} /> : <GitCommitVertical size={13} />}
          {isStash ? sha : detail.parents.length > 1 ? t("병합 커밋") : t("커밋")}
          <button className="sha-chip mono" onClick={() => copyText(detail.hash, t("SHA를 복사했습니다"))} title={t("SHA 복사")}>
            {detail.hash.slice(0, 10)} <Copy size={11} />
          </button>
        </div>
        <h2 className="commit-subject">{detail.subject}</h2>
        {detail.body && <pre className="commit-body">{detail.body}</pre>}
        {refs.length > 0 && (
          <div className="chip-row">
            {refs.map((r) => (
              <span key={r.name} className={"chip" + (r.kind === "tag" ? " tag" : "")}>
                {r.short}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="author-card">
        <span className="avatar" style={{ background: color }}>
          {initials(detail.authorName)}
        </span>
        <div>
          <div>
            <strong>{detail.authorName}</strong> <span className="muted tiny">{detail.authorEmail}</span>
          </div>
          <div className="muted tiny" title={absoluteTime(detail.authorTime)}>{t("작성")}{" "}{absoluteTime(detail.authorTime)} · {relativeTime(detail.authorTime)}
          </div>
          {(detail.committerName !== detail.authorName || Math.abs(detail.commitTime - detail.authorTime) > 60) && (
            <div className="muted tiny">{t("커밋")}{" "}{detail.committerName} · {absoluteTime(detail.commitTime)}
            </div>
          )}
        </div>
      </div>

      <div className="parents">
        <span className="muted tiny">{t("부모")}</span>
        {detail.parents.length === 0 && <span className="muted tiny">{t("없음 (최초 커밋)")}</span>}
        {detail.parents.map((p) => (
          <button key={p} className="sha-chip mono" onClick={() => ctx.jumpTo(p)}>
            {p.slice(0, 8)}
          </button>
        ))}
        {!isStash && (
          <button
            className="icon-btn"
            title={t("웹에서 보기")}
            onClick={() => openOnForge(ctx, (base, kind) => (kind === "gitlab" ? `${base}/-/commit/${detail.hash}` : `${base}/commit/${detail.hash}`))}
          >
            <ExternalLink size={13} />
          </button>
        )}
      </div>

      <div className="files-head">
        <span>{t("변경된 파일")}{" "}<b>{detail.files.length}</b>
        </span>
        <span className="file-stat">
          <span className="green">+{additions}</span> <span className="red">−{deletions}</span>
        </span>
      </div>
      <div className="files">
        {detail.files.map((f) => (
          <FileRow
            key={f.path}
            f={f}
            active={ctx.diff?.kind === "commit" && ctx.diff.path === f.path && ctx.diff.sha === detail.hash}
            onClick={() => ctx.openDiff({ kind: "commit", sha: detail.hash, path: f.path, origPath: f.origPath, label: detail.subject })}
            onContextMenu={(e) =>
              openMenu(e, [
                { label: t("변경 내용 보기"), onClick: () => ctx.openDiff({ kind: "commit", sha: detail.hash, path: f.path, origPath: f.origPath, label: detail.subject }) },
                { label: t("Blame (이 커밋 기준)"), onClick: () => ctx.openBlame({ path: f.path, rev: detail.hash }) },
                { label: t("파일 히스토리"), onClick: () => ctx.showHistory(f.path) },
                { label: t("경로 복사"), icon: <Copy size={14} />, onClick: () => copyText(f.path) },
                { label: t("Finder에서 보기"), onClick: () => revealPath(joinPath(ctx.info.root, f.path)) },
              ])
            }
          />
        ))}
      </div>
    </div>
  );
}
