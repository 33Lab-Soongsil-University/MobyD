import { useEffect, useMemo, useState } from "react";
import { X, History, Loader2 } from "lucide-react";
import { api, errorText } from "../lib/api";
import type { Blame } from "../lib/types";
import { absoluteTime, relativeTime } from "../lib/format";
import { initials } from "../lib/graph";
import { useRepo } from "../repo/RepoContext";
import { t } from "../lib/i18n";
import { useEscape } from "../lib/escape";
import { useUi } from "../store";
import { ErrorBox } from "./ErrorBox";

/** Age → 0..1 heat (newest = 1) for the gutter bar. */
function heat(time: number, min: number, max: number) {
  if (max <= min) return 1;
  return (time - min) / (max - min);
}

export function BlameView() {
  const ctx = useRepo();
  const target = ctx.blame!;
  const [blame, setBlame] = useState<Blame | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setBlame(null);
    setErr(null);
    api
      .blame(ctx.path, target.path, target.rev ?? null)
      .then((b) => !cancel && setBlame(b))
      .catch((e) => !cancel && setErr(errorText(e)));
    return () => {
      cancel = true;
    };
  }, [ctx.path, target.path, target.rev]);

  const isActiveTab = useUi((u) => u.active) === ctx.info.root;
  useEscape(() => ctx.openBlame(null), isActiveTab);

  const range = useMemo(() => {
    const times = Object.values(blame?.commits ?? {})
      .filter((c) => !c.uncommitted)
      .map((c) => c.authorTime);
    return { min: Math.min(...times), max: Math.max(...times) };
  }, [blame]);

  return (
    <div className="diff blame">
      <div className="diff-head">
        <History size={16} className="accent" />
        <div className="diff-title">
          <strong className="mono">{target.path}</strong>
          <span className="muted tiny">Blame · {target.rev ? target.rev.slice(0, 8) : t("작업 트리")}{" "}{t("· 줄마다 마지막으로 바꾼 커밋")}</span>
        </div>
        <div className="diff-tools">
          <button className="btn sm" onClick={() => ctx.showHistory(target.path)}>{t("파일 히스토리")}</button>
          <button className="icon-btn" title={t("닫기 (Esc)")} onClick={() => ctx.openBlame(null)}>
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="diff-body">
        {err && <ErrorBox text={err} />}
        {!blame && !err && (
          <p className="muted pad">
            <Loader2 size={14} className="spin" />{" "}{t("blame 계산 중…")}</p>
        )}
        {blame && (
          <table className="diff-table blame-table">
            <tbody>
              {blame.lines.map((l, i) => {
                const c = blame.commits[l.hash];
                const first = i === 0 || blame.lines[i - 1].hash !== l.hash;
                const h = c && !c.uncommitted ? heat(c.authorTime, range.min, range.max) : 1;
                return (
                  <tr
                    key={i}
                    className={"bl" + (first ? " first" : "") + (hover === l.hash ? " hl" : "")}
                    onMouseEnter={() => setHover(l.hash)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <td className="bl-heat" style={{ opacity: 0.25 + 0.75 * h }} />
                    <td
                      className="bl-who"
                      title={c ? `${c.summary}\n${c.author} · ${absoluteTime(c.authorTime)}\n${c.hash}` : ""}
                      onClick={() => c && !c.uncommitted && ctx.jumpTo(c.hash)}
                    >
                      {first && c && (
                        <>
                          <span className="avatar xs">{c.uncommitted ? "✎" : initials(c.author)}</span>
                          <span className="bl-sum ellipsis">{c.uncommitted ? t("커밋하지 않은 변경") : c.summary}</span>
                          <span className="muted tiny">{c.uncommitted ? "" : relativeTime(c.authorTime)}</span>
                        </>
                      )}
                    </td>
                    <td className="ln">{l.line}</td>
                    <td className="code">{l.text || " "}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
