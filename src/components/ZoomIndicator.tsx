import { useEffect, useState } from "react";
import { t } from "../lib/i18n";

/** Brief "120%" badge after ⌘+ / ⌘− / ⌘0. */
export function ZoomIndicator() {
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const on = (e: Event) => {
      setShown((e as CustomEvent<number>).detail);
      clearTimeout(timer);
      timer = setTimeout(() => setShown(null), 1300);
    };
    window.addEventListener("mobyd-zoom", on);
    return () => {
      window.removeEventListener("mobyd-zoom", on);
      clearTimeout(timer);
    };
  }, []);
  if (shown === null) return null;
  return (
    <div className="zoom-indicator" role="status">
      {t("화면 크기 {pct}%", { pct: Math.round(shown * 100) })}
    </div>
  );
}
