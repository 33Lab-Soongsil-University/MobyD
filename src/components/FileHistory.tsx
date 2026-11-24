import { useEffect, useState } from "react";
import { X, History } from "lucide-react";
import { api, errorText } from "../lib/api";
import type { Commit } from "../lib/types";
import { relativeTime } from "../lib/format";
import { useRepo } from "../repo/RepoContext";
import { t } from "../lib/i18n";
import { useEscape } from "../lib/escape";
import { useUi } from "../store";
import { ErrorBox } from "./ErrorBox";

export function FileHistory() {
  const ctx = useRepo();
  const path = ctx.historyPath!;
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    api
      .fileHistory(ctx.path, path)
      .then((c) => !cancel && setCommits(c))
      .catch((e) => !cancel && setErr(errorText(e)));
    return () => {
      cancel = true;
    };
  }, [ctx.path, path]);

  const close = () => ctx.showHistory(null);
  const isActiveTab = useUi((u) => u.active) === ctx.info.root;
  useEscape(close, isActiveTab);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog wide" tabIndex={-1}>
        <div className="dialog-title-row">
          <h3>
            <History size={15} />{" "}{t("파일 히스토리")}</h3>
          <button className="icon-btn" onClick={close} aria-label={t("닫기")}>
            <X size={16} />
          </button>
        </div>
        <p className="mono tiny muted" title={t("이름 변경 추적(--follow)")}>{path}</p>
        {err && <ErrorBox text={err} />}
        {!commits && !err && <p className="muted">{t("불러오는 중…")}</p>}
        <div className="history-list">
          {commits?.map((c) => (
            <div
              key={c.hash}
              className="history-item"
              onClick={() => {
                close();
                ctx.jumpTo(c.hash);
                ctx.openDiff({ kind: "commit", sha: c.hash, path, label: c.subject });
              }}
            >
              <span className="mono tiny muted">{c.short}</span>
              <span className="sub">
                {c.subject} <span className="muted tiny">· {c.authorName}</span>
              </span>
              <span className="muted tiny">{relativeTime(c.authorTime)}</span>
            </div>
          ))}
          {commits?.length === 0 && <p className="muted">{t("이 파일을 바꾼 커밋이 없습니다.")}</p>}
        </div>
      </div>
    </div>
  );
}
