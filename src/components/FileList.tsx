import type { ReactNode } from "react";
import { STATUS_LABEL } from "../lib/format";
import { t } from "../lib/i18n";

export interface FileRowItem {
  path: string;
  origPath?: string | null;
  status: string;
  additions?: number | null;
  deletions?: number | null;
  binary?: boolean;
}

/** Height of `.file-row` in app.css; long lists are windowed with it. */
export const FILE_ROW_HEIGHT = 27;

export function StatusBadge({ status }: { status: string }) {
  const s = status === "?" ? "A" : status;
  return (
    <span className={`st st-${s}`} title={STATUS_LABEL[status] ?? status}>
      {status === "?" ? "+" : s}
    </span>
  );
}

export function FileRow({
  f,
  active,
  onClick,
  onDoubleClick,
  onContextMenu,
  actions,
}: {
  f: FileRowItem;
  active?: boolean;
  onClick?: () => void;
  /** Quick action: stage / unstage in the work-in-progress lists. */
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  actions?: ReactNode;
}) {
  const i = f.path.lastIndexOf("/");
  const dir = i >= 0 ? f.path.slice(0, i + 1) : "";
  const name = i >= 0 ? f.path.slice(i + 1) : f.path;
  return (
    <div className={"file-row" + (active ? " active" : "")} onClick={onClick} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu} title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
      <StatusBadge status={f.status} />
      <span className="file-path">
        <span className="file-name">{name}</span>
        {dir && <span className="file-dir">{dir}</span>}
        {f.origPath && <span className="file-dir"> ← {f.origPath}</span>}
      </span>
      {f.binary ? (
        <span className="muted tiny">{t("바이너리")}</span>
      ) : (
        (f.additions != null || f.deletions != null) && (
          <span className="file-stat">
            {f.additions ? <span className="green">+{f.additions}</span> : null}
            {f.deletions ? <span className="red">−{f.deletions}</span> : null}
          </span>
        )
      )}
      {actions && (
        <span className="file-actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
      )}
    </div>
  );
}
