import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, Columns2, Rows3, Plus, Minus, Trash2, WrapText } from "lucide-react";
import { api, errorText } from "../lib/api";
import { hunkPatch, linesPatch, parseDiff, splitRows, type DiffLine, type FileDiff, type Hunk, type SplitRow } from "../lib/diff";
import { useRepo } from "../repo/RepoContext";
import { confirmAction } from "../store";
import { StatusBadge } from "./FileList";
import { t } from "../lib/i18n";
import { useEscape } from "../lib/escape";
import { useUi } from "../store";
import { ErrorBox } from "./ErrorBox";

type Mode = "unified" | "split";

function prefMode(): Mode {
  try {
    return (localStorage.getItem("mobyd.diffMode") as Mode) || "unified";
  } catch {
    return "unified";
  }
}

export function DiffView() {
  const ctx = useRepo();
  const target = ctx.diff!;
  const [raw, setRaw] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(prefMode);
  const [ignoreWs, setIgnoreWs] = useState(false);
  const [selected, setSelected] = useState<{ hunk: number; lines: Set<number> } | null>(null);
  const statusKey = JSON.stringify(ctx.data?.status ?? null);

  useEffect(() => {
    let cancel = false;
    setErr(null);
    api
      .diff(ctx.path, { kind: target.kind, path: target.path, origPath: target.origPath, sha: target.sha, ignoreWhitespace: ignoreWs })
      .then((t) => !cancel && setRaw(t))
      .catch((e) => !cancel && setErr(errorText(e)));
    return () => {
      cancel = true;
    };
    // statusKey: reload the working-tree diff whenever the index/worktree changes
  }, [ctx.path, target.kind, target.path, target.origPath, target.sha, ignoreWs, target.kind === "commit" ? "" : statusKey]);

  useEffect(() => setSelected(null), [raw]);

  const isActiveTab = useUi((u) => u.active) === ctx.info.root;
  useEscape(() => ctx.openDiff(null), isActiveTab);

  const files = useMemo(() => (raw === null ? [] : parseDiff(raw)), [raw]);
  const file: FileDiff | undefined = files[0];
  // Big diffs only build the lines near the viewport (see HunkLines).
  const lazy = useMemo(() => (file?.hunks.reduce((n, h) => n + h.lines.length, 0) ?? 0) > LAZY_FROM, [file]);
  const canStage = target.kind === "unstaged";
  const canUnstage = target.kind === "staged";

  const setPref = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem("mobyd.diffMode", m);
    } catch {
      /* ignore */
    }
  };

  const applyHunk = async (h: Hunk, action: "stage" | "unstage" | "discard", lines?: Set<number>) => {
    if (!file) return;
    if (action === "discard") {
      const ok = await confirmAction(t("헝크 버리기"), t("이 부분의 변경을 작업 트리에서 되돌립니다."), t("버리기"), true);
      if (!ok) return;
    }
    const reverse = action !== "stage";
    const patch = lines ? linesPatch(file, h, lines, reverse) : hunkPatch(file, h);
    const label = { stage: t("헝크 스테이징"), unstage: t("헝크 해제"), discard: t("헝크 버리기") }[action];
    await ctx.run(label, () => api.applyPatch(ctx.path, patch, action !== "discard", reverse), { quiet: true });
    setSelected(null);
  };

  const toggleLine = useCallback((hi: number, li: number, l: DiffLine) => {
    if (!(canStage || canUnstage) || (l.kind !== "add" && l.kind !== "del")) return;
    setSelected((prev) => {
      const lines = new Set(prev && prev.hunk === hi ? prev.lines : []);
      if (lines.has(li)) lines.delete(li);
      else lines.add(li);
      return lines.size ? { hunk: hi, lines } : null;
    });
  }, [canStage, canUnstage]);

  const title = target.kind === "commit" ? target.label : { staged: t("스테이징됨"), unstaged: t("스테이징 안 됨"), untracked: t("새 파일") }[target.kind];

  return (
    <div className="diff">
      <div className="diff-head">
        {file && <StatusBadge status={file.isNew ? "A" : file.isDeleted ? "D" : file.oldPath && file.newPath && file.oldPath !== file.newPath ? "R" : target.kind === "untracked" ? "?" : "M"} />}
        <div className="diff-title">
          <strong className="mono">{target.path}</strong>
          <span className="muted tiny">
            {title}
            {target.sha && !target.sha.startsWith("stash") ? ` · ${target.sha.slice(0, 8)}` : ""}
            {file && (
              <>
                {" · "}
                <span className="green">+{file.additions}</span> <span className="red">−{file.deletions}</span>
              </>
            )}
          </span>
        </div>
        <div className="diff-tools">
          {target.kind !== "untracked" && (
            <button
              className="btn sm"
              title={t("줄마다 마지막으로 바꾼 커밋 보기")}
              onClick={() => ctx.openBlame({ path: target.path, rev: target.kind === "commit" && !target.sha?.startsWith("stash") ? target.sha : null })}
            >
              Blame
            </button>
          )}
          <button className={"icon-btn" + (ignoreWs ? " on" : "")} title={t("공백 무시")} onClick={() => setIgnoreWs(!ignoreWs)}>
            <WrapText size={15} />
          </button>
          <div className="seg">
            <button className={mode === "unified" ? "on" : ""} onClick={() => setPref("unified")} title={t("한 줄 보기")}>
              <Rows3 size={14} />
            </button>
            <button className={mode === "split" ? "on" : ""} onClick={() => setPref("split")} title={t("나란히 보기")}>
              <Columns2 size={14} />
            </button>
          </div>
          <button className="icon-btn" title={t("닫기 (Esc)")} onClick={() => ctx.openDiff(null)}>
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="diff-body">
        {err && <ErrorBox text={err} />}
        {raw === null && !err && <p className="muted pad">{t("불러오는 중…")}</p>}
        {raw !== null && !file && <p className="muted pad">{t("표시할 변경이 없습니다.")}</p>}
        {file?.binary && <p className="muted pad">{t("바이너리 파일이라 내용을 비교할 수 없습니다.")}</p>}
        {file?.hunks.map((h, hi) => (
          <div className="hunk" key={hi}>
            <div className="hunk-head">
              <span className="mono">{h.header.replace(/@@.*@@/, (m) => m)}</span>
              <span className="flex1" />
              {selected?.hunk === hi && (
                <span className="sel-actions">{t("선택한 줄 {n}개:", { n: selected.lines.size })}{" "}{canStage && (
                    <button className="btn xs" onClick={() => applyHunk(h, "stage", selected.lines)}>
                      <Plus size={11} />{" "}{t("스테이징")}</button>
                  )}
                  {canUnstage && (
                    <button className="btn xs" onClick={() => applyHunk(h, "unstage", selected.lines)}>
                      <Minus size={11} />{" "}{t("해제")}</button>
                  )}
                </span>
              )}
              {canStage && (
                <>
                  <button className="btn xs ghost danger-text" onClick={() => applyHunk(h, "discard")}>
                    <Trash2 size={11} />{" "}{t("버리기")}</button>
                  <button className="btn xs" onClick={() => applyHunk(h, "stage")}>
                    <Plus size={11} />{" "}{t("헝크 스테이징")}</button>
                </>
              )}
              {canUnstage && (
                <button className="btn xs" onClick={() => applyHunk(h, "unstage")}>
                  <Minus size={11} />{" "}{t("헝크 해제")}</button>
              )}
            </div>
            <HunkLines
              hunk={h}
              hunkIndex={hi}
              mode={mode}
              lazy={lazy}
              picked={selected?.hunk === hi ? selected.lines : null}
              onToggle={toggleLine}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Diffs longer than this build their lines in blocks, on demand. */
const LAZY_FROM = 2000;
const BLOCK = 200;
/** `line-height` of `.diff-table`, used until a block has been measured. */
const LINE_HEIGHT = 19;

type ToggleLine = (hunk: number, line: number, l: DiffLine) => void;

/** The lines of one hunk. In a big diff they are cut into blocks and a block
 *  far from the viewport is a spacer of the same height. */
const HunkLines = memo(function HunkLines({ hunk, hunkIndex, mode, lazy, picked, onToggle }: { hunk: Hunk; hunkIndex: number; mode: Mode; lazy: boolean; picked: Set<number> | null; onToggle: ToggleLine }) {
  const rows = useMemo(() => (mode === "split" ? splitRows(hunk) : null), [mode, hunk]);
  const total = rows ? rows.length : hunk.lines.length;
  const blocks: number[] = [];
  for (let i = 0; i < total; i += BLOCK) blocks.push(i);
  return (
    <table className={"diff-table" + (rows ? " split" : "")}>
      {rows ? (
        <colgroup>
          <col className="col-ln" />
          <col />
          <col className="col-ln" />
          <col />
        </colgroup>
      ) : (
        <colgroup>
          <col className="col-ln" />
          <col className="col-ln" />
          <col className="col-sign" />
          <col />
        </colgroup>
      )}
      {blocks.map((start) => (
        <LineBlock key={start} hunk={hunk} hunkIndex={hunkIndex} rows={rows} start={start} end={Math.min(total, start + BLOCK)} lazy={lazy} picked={picked} onToggle={onToggle} />
      ))}
    </table>
  );
});

function LineBlock({ hunk, hunkIndex, rows, start, end, lazy, picked, onToggle }: { hunk: Hunk; hunkIndex: number; rows: SplitRow[] | null; start: number; end: number; lazy: boolean; picked: Set<number> | null; onToggle: ToggleLine }) {
  const body = useRef<HTMLTableSectionElement>(null);
  const height = useRef((end - start) * LINE_HEIGHT);
  const [near, setNear] = useState(!lazy);

  useEffect(() => {
    if (!lazy) {
      setNear(true);
      return;
    }
    const el = body.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        // keep the real height (long lines wrap) so the scrollbar does not jump
        if (!entry.isIntersecting && el.dataset.built) height.current = el.offsetHeight;
        setNear(entry.isIntersecting);
      },
      // the margin only counts against the scrolling panel itself, not the window
      { root: el.closest(".diff-body"), rootMargin: "1200px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [lazy]);

  if (!near) {
    return (
      <tbody ref={body}>
        <tr style={{ height: height.current }}>
          <td colSpan={4} />
        </tr>
      </tbody>
    );
  }
  return (
    <tbody ref={body} data-built="1">
      {rows
        ? rows.slice(start, end).map((r, i) => (
            <tr key={start + i}>
              <SplitCell line={r.left} side="left" />
              <SplitCell line={r.right} side="right" />
            </tr>
          ))
        : hunk.lines.slice(start, end).map((l, i) => {
            const li = start + i;
            return (
              <tr key={li} className={`dl ${l.kind}` + (picked?.has(li) ? " picked" : "")} onClick={() => onToggle(hunkIndex, li, l)}>
                <td className="ln">{l.oldNo ?? ""}</td>
                <td className="ln">{l.newNo ?? ""}</td>
                <td className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</td>
                <td className="code">{l.text || " "}</td>
              </tr>
            );
          })}
    </tbody>
  );
}

function SplitCell({ line, side }: { line: DiffLine | null; side: "left" | "right" }) {
  if (!line)
    return (
      <Fragment>
        <td className="ln empty" />
        <td className="code empty" />
      </Fragment>
    );
  const kind = line.kind === "ctx" ? "ctx" : line.kind;
  return (
    <Fragment>
      <td className={`ln ${kind}`}>{side === "left" ? line.oldNo : line.newNo}</td>
      <td className={`code ${kind}`}>{line.text || " "}</td>
    </Fragment>
  );
}
