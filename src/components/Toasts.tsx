import { CheckCircle2, Info, TriangleAlert, XCircle, X } from "lucide-react";
import { useUi } from "../store";
import { t as tr } from "../lib/i18n";
import { ErrorDetails } from "./ErrorBox";

const ICONS = {
  success: <CheckCircle2 size={16} />,
  info: <Info size={16} />,
  warning: <TriangleAlert size={16} />,
  error: <XCircle size={16} />,
};

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  const hold = useUi((s) => s.holdToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onMouseEnter={() => hold(t.id, true)} onMouseLeave={() => hold(t.id, false)}>
          <span className="toast-icon">{ICONS[t.kind]}</span>
          <div className="toast-body">
            <strong>{t.title}</strong>
            {t.detail && <p className="toast-detail">{t.detail}</p>}
            <ErrorDetails text={t.detail} />
          </div>
          <button className="icon-btn" onClick={() => dismiss(t.id)} aria-label={tr("닫기")}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
