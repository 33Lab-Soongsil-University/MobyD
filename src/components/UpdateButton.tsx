import { ArrowDownToLine, Loader2 } from "lucide-react";
import { confirmAction } from "../store";
import { t } from "../lib/i18n";
import { installUpdate, useUpdate } from "../lib/updater";

/** Ask once, then download, install and restart. */
export async function offerUpdate() {
  const { version, notes } = useUpdate.getState();
  if (!version) return;
  const ok = await confirmAction(
    t("MobyD {version} 업데이트", { version }),
    <>
      <p>{t("새 버전을 내려받아 설치한 뒤 MobyD를 다시 시작합니다. 열린 탭은 그대로 돌아옵니다.")}</p>
      {notes && <pre className="update-notes">{notes}</pre>}
    </>,
    t("업데이트하고 다시 시작"),
  );
  if (ok) await installUpdate();
}

/** Top-bar pill that appears only while an update is on offer or being installed. */
export function UpdateButton() {
  const { phase, version, progress } = useUpdate();
  if (phase !== "available" && phase !== "downloading" && phase !== "installed") return null;
  const busy = phase !== "available";
  return (
    <button className="update-btn" disabled={busy} onClick={offerUpdate} title={t("새 버전 {version}이(가) 있습니다", { version: version ?? "" })}>
      {busy ? <Loader2 size={13} className="spin" /> : <ArrowDownToLine size={13} />}
      <span>
        {phase === "available"
          ? t("업데이트 {version}", { version: version ?? "" })
          : phase === "installed"
            ? t("다시 시작하는 중…")
            : progress == null
              ? t("내려받는 중…")
              : t("내려받는 중 {pct}%", { pct: Math.round(progress * 100) })}
      </span>
    </button>
  );
}
