import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Archive, Cloud, GitBranch, CircleDot, Tag, PencilLine, Plus, Minus, TriangleAlert } from "lucide-react";
import type { Commit, GraphRow, RefInfo } from "../lib/types";
import { ROW_HEIGHT, graphWidth, groupRefs, initials, laneColor, laneX, matchesFilter, segmentPath, type RefGroup } from "../lib/graph";
import { relativeTime, absoluteTime } from "../lib/format";
import { useRepo } from "../repo/RepoContext";
import { checkoutRef, commitMenu, refMenu } from "../repo/actions";
import { openMenu, type MenuItem } from "../store";
import { t } from "../lib/i18n";

const MAX_GRAPH_WIDTH = 300;

interface RowProps {
  commit: Commit;
  row: GraphRow;
  gw: number;
  selected: boolean;
  isHead: boolean;
  dim: boolean;
  refs: RefInfo[] | undefined;
  wipCounts: { staged: number; unstaged: number; conflicted: number } | null;
  onSelect: (hash: string) => void;
  onContext: (e: React.MouseEvent, c: Commit) => void;
  onRefContext: (e: React.MouseEvent, r: RefInfo) => void;
  onRefOpen: (r: RefInfo) => void;
  refMenuItems: (r: RefInfo) => MenuItem[];
}

function GraphCell({ commit, row, gw, isHead }: { commit: Commit; row: GraphRow; gw: number; isHead: boolean }) {
  const h = ROW_HEIGHT;
  const cx = laneX(row.lane);
  const cy = h / 2;
  const color = laneColor(row.color);
  const isMerge = commit.parents.length > 1;
  return (
    <svg className="graph-cell" width={gw} height={h} viewBox={`0 0 ${gw} ${h}`}>
      {row.segments.map((s, i) => (
        <path key={i} d={segmentPath(s, row.lane, h)} style={{ stroke: laneColor(s.color) }} strokeWidth={2} fill="none" strokeLinecap="round" />
      ))}
      {commit.kind === "wip" ? (
        <circle cx={cx} cy={cy} r={7.5} style={{ fill: "var(--bg)", stroke: color }} strokeWidth={2} strokeDasharray="3 2.4" />
      ) : commit.kind === "stash" ? (
        <rect x={cx - 6.5} y={cy - 6.5} width={13} height={13} rx={3.5} style={{ fill: "var(--bg)", stroke: color }} strokeWidth={2} />
      ) : isMerge ? (
        <circle cx={cx} cy={cy} r={4.6} style={{ fill: color }} />
      ) : (
        <g>
          <circle cx={cx} cy={cy} r={8.6} style={{ fill: color }} />
          <text x={cx} y={cy + 3} textAnchor="middle" className="node-initials">
            {initials(commit.authorName)}
          </text>
        </g>
      )}
      {isHead && <circle cx={cx} cy={cy} r={isMerge ? 7.5 : 11.2} fill="none" style={{ stroke: "var(--text)" }} strokeWidth={1.6} />}
    </svg>
  );
}

function RefPill({ g, color, onContext, onOpen }: { g: RefGroup; color: string; onContext: (e: React.MouseEvent, r: RefInfo) => void; onOpen: (r: RefInfo) => void }) {
  const primary = g.local ?? g.remotes[0] ?? g.tag!;
  return (
    <span
      className={"ref-pill" + (g.isHead ? " head" : "") + (g.kind === "tag" ? " tag" : "")}
      style={{ ["--lane" as string]: color }}
      title={[g.local?.short, ...g.remotes.map((r) => r.short), g.tag?.short].filter(Boolean).join(" · ")}
      onContextMenu={(e) => {
        e.stopPropagation();
        onContext(e, primary);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onOpen(primary);
      }}
    >
      {g.kind === "tag" ? (
        <Tag size={11} />
      ) : (
        <>
          {g.local && (g.isHead ? <CircleDot size={11} /> : <GitBranch size={11} />)}
          {g.remotes.length > 0 && <Cloud size={11} />}
        </>
      )}
      <span className="ref-name">{g.label}</span>
    </span>
  );
}

const Row = memo(function Row(p: RowProps) {
  const { commit: c } = p;
  const color = laneColor(p.row.color);
  const groups = p.refs ? groupRefs(p.refs) : [];
  return (
    <div
      className={"g-row" + (p.selected ? " selected" : "") + (p.dim ? " dim" : "") + (c.kind ? ` k-${c.kind}` : "")}
      style={{ ["--lane" as string]: color }}
      onMouseDown={() => p.onSelect(c.hash)}
      onContextMenu={(e) => p.onContext(e, c)}
    >
      <div className="c-refs">
        {groups.slice(0, 2).map((g) => (
          <RefPill key={g.kind + g.label} g={g} color={color} onContext={p.onRefContext} onOpen={p.onRefOpen} />
        ))}
        {groups.length > 2 && (
          <span
            className="ref-more"
            title={groups.slice(2).map((g) => g.label).join("\n")}
            onContextMenu={(e) => {
              e.stopPropagation();
              const rest = groups.slice(2);
              openMenu(
                e,
                rest.map((g) => ({
                  label: g.label,
                  icon: g.kind === "tag" ? <Tag size={13} /> : <GitBranch size={13} />,
                  submenu: p.refMenuItems(g.local ?? g.remotes[0] ?? g.tag!),
                })),
              );
            }}
          >
            +{groups.length - 2}
          </span>
        )}
        {groups.length > 0 && <span className="ref-link" />}
      </div>
      <div className="c-graph" style={{ width: p.gw }}>
        <GraphCell commit={c} row={p.row} gw={p.gw} isHead={p.isHead} />
      </div>
      <div className="c-msg">
        {c.kind === "wip" ? (
          <span className="wip-label">
            <PencilLine size={13} /> <i>{t("// 작업 중인 변경")}</i>
            {p.wipCounts && (
              <span className="wip-counts">
                {p.wipCounts.conflicted > 0 && (
                  <span className="red">
                    <TriangleAlert size={11} /> {p.wipCounts.conflicted}
                  </span>
                )}
                {p.wipCounts.unstaged > 0 && (
                  <span className="amber">
                    <Minus size={11} /> {p.wipCounts.unstaged}
                  </span>
                )}
                {p.wipCounts.staged > 0 && (
                  <span className="green">
                    <Plus size={11} /> {p.wipCounts.staged}
                  </span>
                )}
              </span>
            )}
          </span>
        ) : c.kind === "stash" ? (
          <span className="stash-label">
            <Archive size={12} /> {c.subject}
          </span>
        ) : (
          c.subject
        )}
      </div>
      <div className="c-author">{c.kind ? "" : c.authorName}</div>
      <div className="c-date" title={c.kind === "wip" ? "" : absoluteTime(c.authorTime)}>
        {c.kind === "wip" ? "" : relativeTime(c.authorTime)}
      </div>
      <div className="c-sha mono">{c.kind ? "" : c.short}</div>
    </div>
  );
});

type Col = "author" | "date" | "sha";
const COL_LABEL: Record<Col, string> = { author: t("작성자"), date: t("날짜"), sha: "SHA" };

function loadHidden(): Col[] {
  try {
    return JSON.parse(localStorage.getItem("mobyd.hiddenCols") ?? "[]");
  } catch {
    return [];
  }
}

export function GraphView() {
  const ctx = useRepo();
  const data = ctx.data;
  const parent = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Col[]>(loadHidden);
  const toggleCol = (c: Col) => {
    const next = hidden.includes(c) ? hidden.filter((x) => x !== c) : [...hidden, c];
    setHidden(next);
    try {
      localStorage.setItem("mobyd.hiddenCols", JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const headerMenu = (e: React.MouseEvent) =>
    openMenu(
      e,
      (Object.keys(COL_LABEL) as Col[]).map((c) => ({
        label: `${hidden.includes(c) ? t("보이기") : t("숨기기")}: ${COL_LABEL[c]}`,
        onClick: () => toggleCol(c),
      })),
    );
  const [matchCursor, setMatchCursor] = useState(0);
  const commits = data?.commits ?? [];
  const rows = data?.rows ?? [];
  const gw = Math.min(MAX_GRAPH_WIDTH, graphWidth(data?.maxLanes ?? 1));
  const count = commits.length + (data?.hasMore ? 1 : 0);

  const virt = useVirtualizer({
    count,
    getScrollElement: () => parent.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 18,
  });

  const matches = useMemo(() => {
    if (!ctx.filter) return [] as number[];
    const out: number[] = [];
    commits.forEach((c, i) => !c.kind && matchesFilter(c, ctx.filter) && out.push(i));
    return out;
  }, [commits, ctx.filter]);

  useEffect(() => {
    setMatchCursor(0);
    if (matches.length) virt.scrollToIndex(matches[0], { align: "center" });
  }, [matches]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ctx.scrollTarget) return;
    const i = ctx.rowIndex.get(ctx.scrollTarget.hash);
    if (i !== undefined) virt.scrollToIndex(i, { align: "center" });
  }, [ctx.scrollTarget]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSelect = useCallback((hash: string) => ctx.select(hash), [ctx.select]);
  const onContext = useCallback((e: React.MouseEvent, c: Commit) => {
    ctx.select(c.hash);
    openMenu(e, commitMenu(ctx, c));
  }, [ctx]);
  const onRefContext = useCallback((e: React.MouseEvent, r: RefInfo) => openMenu(e, refMenu(ctx, r)), [ctx]);
  const onRefOpen = useCallback((r: RefInfo) => checkoutRef(ctx, r), [ctx]);
  const refMenuItems = useCallback((r: RefInfo) => refMenu(ctx, r), [ctx]);

  // Enter / Shift+Enter in the commit search box (toolbar) walks the matches.
  const stepMatch = useCallback(
    (dir: 1 | -1) => {
      if (!matches.length) return;
      const onCurrent = ctx.selected === commits[matches[matchCursor]]?.hash;
      const next = onCurrent ? (matchCursor + dir + matches.length) % matches.length : matchCursor;
      setMatchCursor(next);
      ctx.select(commits[matches[next]].hash);
      virt.scrollToIndex(matches[next], { align: "center" });
    },
    [matches, matchCursor, commits, ctx, virt],
  );
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ root: string; dir: 1 | -1 }>).detail;
      if (d.root === ctx.info.root) stepMatch(d.dir);
    };
    window.addEventListener("mobyd-search-step", on);
    return () => window.removeEventListener("mobyd-search-step", on);
  }, [stepMatch, ctx.info.root]);

  const onKey = (e: React.KeyboardEvent) => {
    if (!commits.length) return;
    const cur = ctx.selected ? ctx.rowIndex.get(ctx.selected) ?? 0 : 0;
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      const n = Math.min(commits.length - 1, cur + 1);
      ctx.select(commits[n].hash);
      virt.scrollToIndex(n);
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      const n = Math.max(0, cur - 1);
      ctx.select(commits[n].hash);
      virt.scrollToIndex(n);
    } else if (e.key === "Home") {
      ctx.select(commits[0].hash);
      virt.scrollToIndex(0);
    } else if (e.key === "Enter" && matches.length) {
      stepMatch(e.shiftKey ? -1 : 1);
    }
  };

  const status = data?.status;
  const wipCounts = status
    ? { staged: status.staged.length, unstaged: status.unstaged.length, conflicted: status.conflicted.length }
    : null;
  const headCommit = data?.head.commit;
  const hasWip = commits[0]?.kind === "wip";
  const matchSet = useMemo(() => new Set(matches), [matches]);

  if (ctx.loading && !data) {
    return (
      <div className="graph-empty">
        <div className="swim">
          <span className="dot" />
          <span className="dot" />
          <span className="dot" />
        </div>
        <p className="muted">{t("커밋 그래프를 불러오는 중…")}</p>
      </div>
    );
  }

  return (
    <div className={"graph" + hidden.map((c) => ` hide-${c}`).join("")}>
      <div className="g-header" onContextMenu={headerMenu} title={t("오른쪽 클릭: 열 보이기/숨기기")}>
        <div className="h-refs">{t("브랜치 / 태그")}</div>
        <div style={{ width: gw }}>{t("그래프")}</div>
        <div className="flex1">{t("커밋 메시지")}{ctx.filter && t(" · 일치 {length}개 (Enter로 다음)", { length: matches.length })}</div>
        <div className="c-author">{t("작성자")}</div>
        <div className="c-date">{t("날짜")}</div>
        <div className="c-sha">SHA</div>
      </div>
      <div className="g-scroll" ref={parent} tabIndex={0} onKeyDown={onKey}>
        {commits.length === 0 && (
          <div className="graph-empty">
            <p className="muted">{t("아직 커밋이 없습니다. 오른쪽에서 첫 커밋을 만들어 보세요.")}</p>
          </div>
        )}
        <div style={{ height: virt.getTotalSize(), position: "relative" }}>
          {virt.getVirtualItems().map((v) => {
            const style = { position: "absolute" as const, top: 0, left: 0, right: 0, height: ROW_HEIGHT, transform: `translateY(${v.start}px)` };
            if (v.index >= commits.length) {
              return (
                <div key="more" style={style} className="g-more">
                  <button className="btn sm" onClick={() => ctx.loadMore()}>{t("커밋 2,000개 더 불러오기")}</button>
                </div>
              );
            }
            const c = commits[v.index];
            return (
              <div key={c.hash} style={style}>
                <Row
                  commit={c}
                  row={rows[v.index]}
                  gw={gw}
                  selected={ctx.selected === c.hash}
                  isHead={c.hash === headCommit && !hasWip}
                  dim={!!ctx.filter && !c.kind && !matchSet.has(v.index)}
                  refs={ctx.refIndex.get(c.hash)}
                  wipCounts={c.kind === "wip" ? wipCounts : null}
                  onSelect={onSelect}
                  onContext={onContext}
                  onRefContext={onRefContext}
                  onRefOpen={onRefOpen}
                  refMenuItems={refMenuItems}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
