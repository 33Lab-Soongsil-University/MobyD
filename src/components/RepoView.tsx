import { useEffect, useRef, useState } from "react";
import type { RepoInfo } from "../lib/types";
import { RepoProvider, useRepo, WIP } from "../repo/RepoContext";
import { Toolbar } from "./Toolbar";
import { Sidebar } from "./Sidebar";
import { GraphView } from "./GraphView";
import { CommitPanel } from "./CommitPanel";
import { WipPanel } from "./WipPanel";
import { DiffView } from "./DiffView";
import { PrPanel } from "./PrPanel";
import { OperationBanner } from "./OperationBanner";
import { FileHistory } from "./FileHistory";
import { RebaseModal } from "./RebaseModal";
import { BlameView } from "./BlameView";
import { t } from "../lib/i18n";
import { setRepoCommands, type PaletteCommand } from "./CommandPalette";
import { addWorktreeFlow, checkoutRef, createBranchFlow, createPrFlow, fetchFlow, pullFlow, pushFlow, stashActionFlow, stashFlow } from "../repo/actions";
import { api } from "../lib/api";
import { GitBranch } from "lucide-react";
import { ErrorBox } from "./ErrorBox";

export function RepoView({ info, active }: { info: RepoInfo; active: boolean }) {
  return (
    <RepoProvider info={info} active={active}>
      <RepoLayout active={active} />
    </RepoProvider>
  );
}

/** A side panel width the user can drag; it is remembered across restarts and
 *  a double-click on the divider puts the default back. */
function useResizable(initial: number, min: number, max: number, side: "left" | "right") {
  const key = `mobyd.panel.${side}`;
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(key));
      if (v >= min && v <= max) return v;
    } catch {
      /* storage unavailable */
    }
    return initial;
  });
  const drag = useRef<{ x: number; w: number } | null>(null);
  const save = (w: number) => {
    try {
      localStorage.setItem(key, String(Math.round(w)));
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!drag.current) return;
      const dx = e.clientX - drag.current.x;
      setWidth(Math.min(max, Math.max(min, drag.current.w + (side === "left" ? dx : -dx))));
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.classList.remove("resizing");
      setWidth((w) => {
        save(w);
        return w;
      });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max, side]);
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    drag.current = { x: e.clientX, w: width };
    document.body.classList.add("resizing");
  };
  const onDoubleClick = () => {
    setWidth(initial);
    save(initial);
  };
  return { width, onMouseDown, onDoubleClick };
}

function useUndoKeys(active: boolean) {
  const ctx = useRepo();
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) ctx.redo();
      else ctx.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, ctx]);
}

/** ⌘F focuses the commit search, ⌘R refreshes; the palette gets this repository's commands. */
function useRepoCommands(active: boolean) {
  const ctx = useRepo();
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === "f") {
        e.preventDefault();
        const box = document.querySelector<HTMLInputElement>(".repo-host:not([hidden]) .toolbar .search input");
        box?.focus();
        box?.select();
      } else if (k === "r") {
        e.preventDefault();
        ctx.reload();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, ctx]);

  useEffect(() => {
    if (!active) return;
    setRepoCommands(() => {
      const g = t("저장소");
      const data = ctx.data;
      const dirty = (data?.status.staged.length ?? 0) + (data?.status.unstaged.length ?? 0);
      const head = data?.head.branch ?? null;
      const cmds: PaletteCommand[] = [
        { id: "fetch", title: t("Fetch (모든 원격)"), group: g, words: "fetch", run: () => fetchFlow(ctx) },
        { id: "pull", title: t("최신 변경 받기 (Pull)"), group: g, words: "pull", run: () => pullFlow(ctx) },
        { id: "pull-rebase", title: "Pull — rebase", group: g, words: "pull rebase", run: () => pullFlow(ctx, "rebase") },
        { id: "push", title: t("내 커밋 올리기 (Push)"), group: g, words: "push", run: () => pushFlow(ctx) },
        { id: "branch", title: t("새 브랜치 만들기"), group: g, words: "new branch create", run: () => createBranchFlow(ctx) },
        { id: "stash", title: t("작업 중인 변경을 잠시 보관 (Stash)"), group: g, words: "stash", disabled: dirty === 0, run: () => stashFlow(ctx) },
        { id: "pop", title: t("마지막 Stash 꺼내기 (Pop)"), group: g, words: "stash pop", disabled: !data?.stashes.length, run: () => stashActionFlow(ctx, "pop", 0) },
        { id: "undo", title: data?.undo.undo ? t("실행 취소: {undo} (⌘Z)", { undo: data.undo.undo }) : t("실행 취소"), group: g, keys: "⌘Z", words: "undo", disabled: !data?.undo.undo, run: () => ctx.undo() },
        { id: "redo", title: data?.undo.redo ? t("다시 실행: {redo} (⇧⌘Z)", { redo: data.undo.redo }) : t("다시 실행"), group: g, keys: "⇧⌘Z", words: "redo", disabled: !data?.undo.redo, run: () => ctx.redo() },
        { id: "worktree", title: t("워크트리 추가"), group: g, words: "worktree add", run: () => addWorktreeFlow(ctx) },
        { id: "pr", title: t("풀 리퀘스트 만들기"), group: g, words: "pull request pr create", run: () => createPrFlow(ctx) },
        { id: "search", title: t("커밋 검색"), group: g, keys: "⌘F", words: "search find commit", run: () => document.querySelector<HTMLInputElement>(".repo-host:not([hidden]) .toolbar .search input")?.focus() },
        { id: "refresh", title: t("새로고침"), group: g, keys: "⌘R", words: "refresh reload", run: () => ctx.reload() },
        { id: "terminal", title: t("이 폴더에서 터미널 열기"), group: g, words: "terminal shell", run: () => api.openTerminal(ctx.info.root).catch(() => {}) },
      ];
      const locals = (data?.refs ?? []).filter((r) => r.kind === "local").sort((a, b) => b.date - a.date);
      for (const r of locals) {
        if (r.short === head) continue;
        cmds.push({
          id: `co-${r.short}`,
          title: t("'{short}' 체크아웃", { short: r.short }),
          group: t("브랜치"),
          icon: <GitBranch size={14} />,
          words: `checkout switch ${r.short}`,
          run: () => checkoutRef(ctx, r),
        });
      }
      for (const r of (data?.refs ?? []).filter((x) => x.kind === "remote" && !locals.some((l) => x.short.endsWith("/" + l.short)))) {
        cmds.push({
          id: `co-${r.short}`,
          title: t("'{short}' 체크아웃", { short: r.short }),
          group: t("원격 브랜치"),
          icon: <GitBranch size={14} />,
          words: `checkout ${r.short}`,
          run: () => checkoutRef(ctx, r),
        });
      }
      return cmds;
    });
    return () => setRepoCommands(null);
  }, [active, ctx]);
}

function RepoLayout({ active }: { active: boolean }) {
  const ctx = useRepo();
  useUndoKeys(active);
  useRepoCommands(active);
  const left = useResizable(244, 190, 460, "left");
  const right = useResizable(372, 300, 720, "right");

  if (ctx.error && !ctx.data) {
    return (
      <div className="repo-error">
        <h3>{t("저장소를 읽을 수 없습니다")}</h3>
        <ErrorBox text={ctx.error} />
        <button className="btn" onClick={() => ctx.reload()}>{t("다시 시도")}</button>
      </div>
    );
  }

  const showWip = ctx.selected === WIP;
  return (
    <div className="repo">
      <Toolbar />
      <OperationBanner />
      <div className="repo-body">
        <aside className="sidebar" style={{ width: left.width }}>
          <Sidebar />
        </aside>
        <div className="splitter" onMouseDown={left.onMouseDown} onDoubleClick={left.onDoubleClick} title={t("끌어서 폭 조절 · 더블클릭하면 기본 폭")} />
        <section className="center">
          <GraphView />
          {ctx.diff && <DiffView />}
          {ctx.blame && <BlameView />}
        </section>
        <div className="splitter" onMouseDown={right.onMouseDown} onDoubleClick={right.onDoubleClick} title={t("끌어서 폭 조절 · 더블클릭하면 기본 폭")} />
        <aside className="detail" style={{ width: right.width }}>
          {ctx.pr ? <PrPanel /> : showWip ? <WipPanel /> : <CommitPanel />}
        </aside>
      </div>
      {ctx.historyPath && <FileHistory />}
      {ctx.rebaseBase && <RebaseModal />}
    </div>
  );
}
