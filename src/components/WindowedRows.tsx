// Long lists of fixed-height rows (thousands of changed files) only build the
// rows near the viewport. The list can sit anywhere inside a scrolling panel
// next to other content: its position is read from the layout, not assumed.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Below this many rows everything is rendered as before. */
export const WINDOW_FROM = 200;
const OVERSCAN = 12;

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return null;
}

/** Which rows of a `count`-row list are near the visible part of its scroll parent. */
export function visibleRange(listTop: number, viewTop: number, viewHeight: number, rowHeight: number, count: number, overscan = OVERSCAN): [number, number] {
  const from = Math.floor((viewTop - listTop) / rowHeight) - overscan;
  const to = Math.ceil((viewTop - listTop + viewHeight) / rowHeight) + overscan;
  const start = Math.max(0, Math.min(count, from));
  return [start, Math.max(start, Math.min(count, to))];
}

export function WindowedRows<T>({ items, rowHeight, render }: { items: T[]; rowHeight: number; render: (item: T, index: number) => ReactNode }) {
  const windowed = items.length > WINDOW_FROM;
  const box = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<[number, number]>([0, Math.min(items.length, 60)]);

  // Runs after every render too: content above the list (another list, a banner)
  // can change height without any scroll event.
  useLayoutEffect(() => {
    if (!windowed) return;
    const el = box.current;
    const scroller = scrollParent(el);
    if (!el || !scroller) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const view = scroller.getBoundingClientRect();
      const next = visibleRange(el.getBoundingClientRect().top, view.top, view.height, rowHeight, items.length);
      setRange((prev) => (prev[0] === next[0] && prev[1] === next[1] ? prev : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(scroller);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      ro.disconnect();
    };
  });

  if (!windowed) return <>{items.map(render)}</>;
  const [start, end] = range;
  return (
    <div ref={box} style={{ height: items.length * rowHeight, position: "relative" }}>
      <div style={{ position: "absolute", top: start * rowHeight, left: 0, right: 0 }}>
        {items.slice(start, end).map((item, i) => render(item, start + i))}
      </div>
    </div>
  );
}
