import { useState } from "react";
import { ChevronRight, Copy } from "lucide-react";
import { rawFor } from "../lib/errors";
import { t } from "../lib/i18n";

/** "Details" disclosure with the original error text and a copy button. */
export function ErrorDetails({ text }: { text: string | null | undefined }) {
  const raw = rawFor(text);
  const [open, setOpen] = useState(false);
  if (!raw) return null;
  return (
    <div className="error-details">
      <button className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={12} className={open ? "rot90" : ""} /> {open ? t("자세히 숨기기") : t("자세히")}
      </button>
      {open && (
        <>
          <pre>{raw}</pre>
          <button className="link-btn" onClick={() => navigator.clipboard?.writeText(raw).catch(() => {})}>
            <Copy size={12} /> {t("원문 복사")}
          </button>
        </>
      )}
    </div>
  );
}

/** An inline error: the friendly sentence, with the original behind "details". */
export function ErrorBox({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={"error-box " + className} role="alert">
      <p>{text}</p>
      <ErrorDetails text={text} />
    </div>
  );
}
