// Esc closes the top-most layer only (menu > dialog > blame/diff), wherever the
// keyboard focus happens to be. Each open layer registers its close handler;
// the one registered last wins.
import { useEffect, useRef } from "react";

const stack: { current: () => void }[] = [];
let listening = false;

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  top.current();
}

/** Close this layer on Esc while `active`. */
export function useEscape(close: () => void, active = true) {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!active) return;
    if (!listening) {
      window.addEventListener("keydown", onKey);
      listening = true;
    }
    stack.push(ref);
    return () => {
      const i = stack.lastIndexOf(ref);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}
