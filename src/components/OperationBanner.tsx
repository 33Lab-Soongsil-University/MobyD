import { TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import { useRepo, WIP } from "../repo/RepoContext";
import { confirmAction } from "../store";
import { t } from "../lib/i18n";

const NAMES: Record<string, string> = {
  merge: t("병합"),
  rebase: t("리베이스"),
  "cherry-pick": t("체리픽"),
  revert: t("되돌리기"),
};

export function OperationBanner() {
  const ctx = useRepo();
  const st = ctx.data?.state;
  if (!st?.operation) return null;
  const op = st.operation;
  const conflicts = ctx.data?.status.conflicted.length ?? 0;
  const name = NAMES[op] ?? op;

  return (
    <div className="op-banner">
      <TriangleAlert size={15} />
      <span>
        <b>{name}</b>{" "}{t("진행 중")}{op === "rebase" && st.step && st.total ? ` (${st.step}/${st.total})` : ""}
        {st.headName ? ` · ${st.headName}` : ""}
        {conflicts > 0 ? t(" · 충돌 파일 {conflicts}개", { conflicts }) : t(" · 충돌을 모두 해결했습니다")}
      </span>
      <div className="op-actions">
        <button className="btn sm" onClick={() => ctx.select(WIP)}>{t("변경 보기")}</button>
        <button
          className="btn sm primary"
          disabled={conflicts > 0}
          onClick={() => ctx.runOp(t("{name} 계속", { name }), () => api.sequencer(ctx.path, op, "continue"))}
        >{t("계속")}</button>
        {op !== "merge" && (
          <button className="btn sm" onClick={() => ctx.runOp(t("{name} 건너뛰기", { name }), () => api.sequencer(ctx.path, op, "skip"))}>{t("건너뛰기")}</button>
        )}
        <button
          className="btn sm danger"
          onClick={async () => {
            if (await confirmAction(t("{name} 중단", { name }), t("작업 전 상태로 되돌립니다."), t("중단"), true))
              await ctx.runOp(t("{name} 중단", { name }), () => api.sequencer(ctx.path, op, "abort"), t("{name}을(를) 중단했습니다", { name }));
          }}
        >{t("중단")}</button>
      </div>
    </div>
  );
}
