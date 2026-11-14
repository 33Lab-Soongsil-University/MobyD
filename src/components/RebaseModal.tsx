import { useEffect, useMemo, useState } from "react";
import { X, ArrowUp, ArrowDown, GripVertical, Loader2, TriangleAlert, Workflow } from "lucide-react";
import { api, errorText } from "../lib/api";
import type { Commit, RebaseAction, RebaseStep } from "../lib/types";
import { relativeTime } from "../lib/format";
import { useRepo } from "../repo/RepoContext";
import { t } from "../lib/i18n";
import { useEscape } from "../lib/escape";
import { useUi } from "../store";
import { tj } from "../lib/i18n-react";

interface Row {
  commit: Commit;
  action: RebaseAction;
  message: string;
}

const ACTIONS: { id: RebaseAction; label: string; hint: string }[] = [
  { id: "pick", label: "Pick", hint: t("그대로 사용") },
  { id: "reword", label: "Reword", hint: t("메시지만 바꾸기") },
  { id: "edit", label: "Edit", hint: t("이 커밋에서 멈추고 고치기") },
  { id: "squash", label: "Squash", hint: t("위 커밋과 합치고 메시지도 합치기") },
  { id: "fixup", label: "Fixup", hint: t("위 커밋과 합치고 이 메시지는 버리기") },
  { id: "drop", label: "Drop", hint: t("커밋 삭제") },
];

/**
 * GitKraken-style interactive rebase: newest commit on top, drag or use the
 * arrows to reorder, pick an action per commit, then start the rebase.
 */
export function RebaseModal() {
  const ctx = useRepo();
  const base = ctx.rebaseBase!;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);

  useEffect(() => {
    api
      .rebasePlan(ctx.path, base.hash)
      .then((plan) => {
        if (plan.hasMerges) setErr(t("이 구간에 병합 커밋이 있습니다. 인터랙티브 리베이스는 병합 커밋을 펼쳐서 다시 씁니다. 병합이 없는 구간에서 시작하세요."));
        setBranch(plan.branch);
        // display newest first, like the graph
        setRows(plan.commits.map((c) => ({ commit: c, action: "pick" as RebaseAction, message: c.subject })).reverse());
      })
      .catch((e) => setErr(errorText(e)));
  }, [ctx.path, base.hash]);

  const close = () => ctx.startRebase(null);
  const isActiveTab = useUi((u) => u.active) === ctx.info.root;
  useEscape(() => {
    if (!busy) close();
  }, isActiveTab);

  const move = (from: number, to: number) => {
    if (!rows || to < 0 || to >= rows.length || from === to) return;
    const next = [...rows];
    const [r] = next.splice(from, 1);
    next.splice(to, 0, r);
    setRows(next);
  };

  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs && rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  // Oldest-first order is what git needs; squash/fixup fold into the commit below them on screen.
  const problem = useMemo(() => {
    if (!rows) return null;
    const oldestFirst = [...rows].reverse().filter((r) => r.action !== "drop");
    if (oldestFirst.length && (oldestFirst[0].action === "squash" || oldestFirst[0].action === "fixup"))
      return t("가장 아래(가장 오래된) 커밋은 squash/fixup 할 수 없습니다.");
    return null;
  }, [rows]);

  const changed = rows?.some((r, i, all) => r.action !== "pick" || r.message !== r.commit.subject || all.length - 1 - i !== i) ?? false;

  const start = async () => {
    if (!rows) return;
    const oldestFirst = [...rows].reverse();
    const steps: RebaseStep[] = oldestFirst.map((r, i) => {
      const nextAction = oldestFirst[i + 1]?.action;
      const groupEnd = (r.action === "squash" || r.action === "fixup") && nextAction !== "squash" && nextAction !== "fixup";
      const edited = r.message.trim() && r.message.trim() !== r.commit.subject;
      return {
        action: r.action,
        hash: r.commit.hash,
        message: r.action === "reword" ? r.message : groupEnd && edited ? r.message : null,
      };
    });
    setBusy(true);
    const out = await ctx.runOp(t("인터랙티브 리베이스"), () => api.rebaseInteractive(ctx.path, base.hash, steps), t("인터랙티브 리베이스를 마쳤습니다"));
    setBusy(false);
    if (out) close();
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div className="dialog xl rebase">
        <div className="dialog-title-row">
          <h3>
            <Workflow size={16} />{" "}{t("인터랙티브 리베이스 ·")}{" "}{branch ?? "HEAD"} → {base.label}
          </h3>
          <button className="icon-btn" onClick={close} disabled={busy}>
            <X size={16} />
          </button>
        </div>
        <p className="muted tiny">{tj(
            "위가 최신 커밋입니다. 끌어서 순서를 바꾸고 커밋마다 동작을 고르세요. Squash/Fixup은 바로 아래 커밋에 합쳐집니다. 커밋하지 않은 변경은 자동으로 보관했다가 되돌려 놓습니다(--autostash). 끝난 뒤 툴바의 {undo}로 원래대로 돌릴 수 있습니다.",
            { undo: <b>{t("실행 취소")}</b> },
          )}
        </p>
        {err && (
          <p className="warn-box">
            <TriangleAlert size={14} /> {err}
          </p>
        )}
        {!rows && !err && (
          <p className="muted pad">
            <Loader2 size={14} className="spin" />{" "}{t("커밋 목록을 읽는 중…")}</p>
        )}
        <div className="rebase-list">
          {rows?.map((r, i) => (
            <div
              key={r.commit.hash}
              className={`rebase-row a-${r.action}` + (drag === i ? " dragging" : "")}
              draggable
              onDragStart={() => setDrag(i)}
              onDragOver={(e) => {
                e.preventDefault();
                if (drag !== null && drag !== i) {
                  move(drag, i);
                  setDrag(i);
                }
              }}
              onDragEnd={() => setDrag(null)}
            >
              <GripVertical size={14} className="muted grip" />
              <select value={r.action} onChange={(e) => setRow(i, { action: e.target.value as RebaseAction })} title={ACTIONS.find((a) => a.id === r.action)?.hint}>
                {ACTIONS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
              <span className="mono tiny muted">{r.commit.short}</span>
              {r.action === "reword" || ((r.action === "squash" || r.action === "fixup") && (rows[i - 1]?.action !== "squash" && rows[i - 1]?.action !== "fixup")) ? (
                <input
                  className="flex1"
                  value={r.message}
                  onChange={(e) => setRow(i, { message: e.target.value })}
                  placeholder={r.action === "reword" ? t("새 커밋 메시지") : t("합친 커밋의 메시지 (비우면 기본)")}
                />
              ) : (
                <span className={"flex1 ellipsis" + (r.action === "drop" ? " struck" : "")}>{r.commit.subject}</span>
              )}
              <span className="muted tiny">{r.commit.authorName}</span>
              <span className="muted tiny">{relativeTime(r.commit.authorTime)}</span>
              <button className="icon-btn" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={t("위로")}>
                <ArrowUp size={13} />
              </button>
              <button className="icon-btn" disabled={i === rows.length - 1} onClick={() => move(i, i + 1)} aria-label={t("아래로")}>
                <ArrowDown size={13} />
              </button>
            </div>
          ))}
          {rows?.length === 0 && <p className="sb-empty">{t("이 커밋 이후로 다시 쓸 커밋이 없습니다.")}</p>}
        </div>
        {problem && (
          <p className="warn-box">
            <TriangleAlert size={14} /> {problem}
          </p>
        )}
        <div className="dialog-actions">
          <button className="btn" onClick={close} disabled={busy}>{t("취소")}</button>
          <button className="btn primary" onClick={start} disabled={busy || !rows?.length || !!problem || !changed || !!err}>
            {busy ? <Loader2 size={14} className="spin" /> : <Workflow size={14} />}{" "}{t("리베이스 시작")}</button>
        </div>
      </div>
    </div>
  );
}
