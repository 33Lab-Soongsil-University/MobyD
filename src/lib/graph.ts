import type { Commit, RefInfo, Segment } from "./types";

export const ROW_HEIGHT = 30;
export const LANE_WIDTH = 18;
export const GRAPH_PAD = 12;

/** Lane palette size; the actual colours are CSS variables (`--lane-0` … `--lane-11`) so each theme can tune contrast. */
export const LANE_COUNT = 12;

export const laneColor = (i: number) => `var(--lane-${((i % LANE_COUNT) + LANE_COUNT) % LANE_COUNT})`;

export const laneX = (lane: number) => GRAPH_PAD + lane * LANE_WIDTH + LANE_WIDTH / 2;

export function graphWidth(maxLanes: number) {
  return GRAPH_PAD * 2 + Math.max(1, maxLanes) * LANE_WIDTH;
}

/**
 * SVG path for one segment inside a row of height `h`, node at `nodeLane`.
 * Lane changes are drawn as rounded elbows (quadratic curves), the look of
 * most modern graph views.
 */
export function segmentPath(seg: Segment, nodeLane: number, h = ROW_HEIGHT): string {
  const mid = h / 2;
  if (seg.kind === "pass") {
    const x1 = laneX(seg.from);
    const x2 = laneX(seg.to);
    return `M${x1} 0L${x2} ${h}`;
  }
  if (seg.kind === "enter") {
    const x1 = laneX(seg.from);
    const x2 = laneX(nodeLane);
    if (x1 === x2) return `M${x1} 0L${x2} ${mid}`;
    return `M${x1} 0Q${x1} ${mid} ${x2} ${mid}`;
  }
  const x1 = laneX(nodeLane);
  const x2 = laneX(seg.to);
  if (x1 === x2) return `M${x1} ${mid}L${x2} ${h}`;
  return `M${x1} ${mid}Q${x2} ${mid} ${x2} ${h}`;
}

export interface RefGroup {
  /** Branch name without remote prefix, or the tag name. */
  label: string;
  kind: "branch" | "tag";
  local: RefInfo | null;
  remotes: RefInfo[];
  tag: RefInfo | null;
  isHead: boolean;
}

/** Merge `main` and `origin/main` pointing at the same commit into one label. */
export function groupRefs(refs: RefInfo[]): RefGroup[] {
  const groups: RefGroup[] = [];
  const byName = new Map<string, RefGroup>();
  const sorted = [...refs].sort((a, b) => order(a) - order(b));
  for (const r of sorted) {
    if (r.kind === "tag") {
      groups.push({ label: r.short, kind: "tag", local: null, remotes: [], tag: r, isHead: false });
      continue;
    }
    const name = r.kind === "remote" && r.remote ? r.short.slice(r.remote.length + 1) : r.short;
    let g = byName.get(name);
    if (!g) {
      g = { label: name, kind: "branch", local: null, remotes: [], tag: null, isHead: false };
      byName.set(name, g);
      groups.push(g);
    }
    if (r.kind === "local") {
      g.local = r;
      g.isHead = r.isHead;
    } else g.remotes.push(r);
  }
  return groups.sort((a, b) => Number(b.isHead) - Number(a.isHead));
}

function order(r: RefInfo) {
  return r.kind === "local" ? 0 : r.kind === "remote" ? 1 : 2;
}

export function refsByCommit(refs: RefInfo[]): Map<string, RefInfo[]> {
  const m = new Map<string, RefInfo[]>();
  for (const r of refs) {
    const list = m.get(r.target);
    if (list) list.push(r);
    else m.set(r.target, [r]);
  }
  return m;
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return [...parts[0]].slice(0, 2).join("").toUpperCase();
  return ([...parts[0]][0] + [...parts[parts.length - 1]][0]).toUpperCase();
}

export function matchesFilter(c: Commit, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return (
    c.subject.toLowerCase().includes(s) ||
    c.authorName.toLowerCase().includes(s) ||
    c.authorEmail.toLowerCase().includes(s) ||
    c.hash.startsWith(s)
  );
}
