// An (i) mark that shows a short explanation on hover or keyboard focus, for
// text that helps once but would clutter the screen if always shown. The
// bubble is rendered at the document root so dialogs' scroll areas never clip it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

export function Hint({ text, size = 12 }: { text: ReactNode; size?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const show = () => {
    const el = ref.current;
    if (!el) return;
    // In the dev bridge the zoom is CSS `zoom` on <html>, which scales the rect but not fixed positions.
    const z = Number(document.documentElement.style.zoom) || 1;
    const r = el.getBoundingClientRect();
    const below = r.top / z < 80;
    const x = Math.min(Math.max((r.left + r.width / 2) / z, 160), window.innerWidth / z - 160);
    setAt({ x, y: (below ? r.bottom : r.top) / z, below });
  };
  const hide = () => setAt(null);
  // A bubble placed for the old position would float away from the mark when anything scrolls.
  useEffect(() => {
    if (!at) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, [at]);
  return (
    <span
      ref={ref}
      className="hint"
      tabIndex={0}
      role="note"
      aria-label={typeof text === "string" ? text : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={(e) => {
        // Inside a <label>/<summary>, a click would toggle the control instead.
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <Info size={size} />
      {at &&
        createPortal(
          <span className={"hint-bubble" + (at.below ? " below" : "")} style={{ left: at.x, top: at.y }} role="tooltip">
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
