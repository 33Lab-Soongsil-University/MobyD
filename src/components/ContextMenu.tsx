import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useEscape } from "../lib/escape";
import { useUi, type MenuItem } from "../store";

function MenuList({ items, onDone }: { items: MenuItem[]; onDone: () => void }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <ul className="menu-list" role="menu">
      {items.map((it, i) =>
        it.separator ? (
          <li key={i} className="menu-sep" role="separator" />
        ) : (
          <li
            key={i}
            role="menuitem"
            className={"menu-item" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : "")}
            onMouseEnter={() => setOpen(it.submenu ? i : null)}
            onClick={(e) => {
              e.stopPropagation();
              if (it.disabled || it.submenu) return;
              onDone();
              it.onClick?.();
            }}
          >
            <span className="menu-icon">{it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
            {it.submenu && <ChevronRight size={13} className="menu-hint" />}
            {it.submenu && open === i && (
              <div className="menu submenu">
                <MenuList items={it.submenu} onDone={onDone} />
              </div>
            )}
          </li>
        ),
      )}
    </ul>
  );
}

export function ContextMenu() {
  const menu = useUi((s) => s.menu);
  const setMenu = useUi((s) => s.setMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - r.width - 8);
    const y = Math.min(menu.y, window.innerHeight - r.height - 8);
    setPos({ x: Math.max(4, x), y: Math.max(4, y) });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu, setMenu]);

  useEscape(() => setMenu(null), Boolean(menu));

  if (!menu) return null;
  return (
    <div
      ref={ref}
      className="menu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuList items={menu.items} onDone={() => setMenu(null)} />
    </div>
  );
}
