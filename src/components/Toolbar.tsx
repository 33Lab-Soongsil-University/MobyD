import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  GitBranch,
  GitBranchPlus,
  GitFork,
  GitPullRequestCreate,
  Archive,
  ArchiveRestore,
  Search,
  FolderOpen,
  Loader2,
  CircleDot,
  SquareTerminal,
  Undo2,
  Redo2,
  Server,
  FolderGit2,
  FolderSearch,
  CloudDownload,
  Link2,
  X,
} from "lucide-react";
import { useRepo } from "../repo/RepoContext";
import {
  addWorktreeFlow,
  checkoutRef,
  createBranchFlow,
  createPrFlow,
  fetchFlow,
  pullFlow,
  pushFlow,
  stashActionFlow,
  stashFlow,
} from "../repo/actions";
import { api, errorText } from "../lib/api";
import { copyText, openRepoPath, revealPath } from "../lib/actions";
import { repoLink } from "../lib/deeplink";
import { openManager, openMenu, toast, useUi } from "../store";
import { MidEllipsis } from "./MidEllipsis";
import { displayRoot, repoBaseName } from "../lib/format";
import { t } from "../lib/i18n";

const anchor = (e: React.MouseEvent) => {
  const r = e.currentTarget.getBoundingClientRect();
  return { clientX: r.left, clientY: r.bottom + 4, preventDefault: () => {} };
};

/** Toolbar laid out like GitKraken: Undo/Redo · Pull/Push · Branch · Stash/Pop · Terminal. */
export function Toolbar() {
  const ctx = useRepo();
  const head = ctx.data?.head;
  const status = ctx.data?.status;
  const stashes = ctx.data?.stashes ?? [];
  const undo = ctx.data?.undo;
  const branchLabel = head?.branch ?? (head?.detached ? t("분리됨 @ {commit}", { commit: head.commit?.slice(0, 7) }) : t("브랜치 없음"));
  const dirty = (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0) + (status?.conflicted.length ?? 0);

  const branchMenu = (e: React.MouseEvent) => {
    const locals = (ctx.data?.refs ?? []).filter((r) => r.kind === "local").sort((a, b) => b.date - a.date);
    openMenu(anchor(e), [
      { label: t("새 브랜치…"), icon: <GitBranchPlus size={14} />, onClick: () => createBranchFlow(ctx) },
      { separator: true },
      ...locals.slice(0, 25).map((r) => ({
        label: r.short,
        icon: r.isHead ? <CircleDot size={14} /> : <GitBranch size={14} />,
        hint: r.ahead || r.behind ? `↑${r.ahead} ↓${r.behind}` : undefined,
        onClick: () => checkoutRef(ctx, r),
      })),
    ]);
  };

  // GitKraken's repository selector: open tabs, recent repositories, open/clone.
  const repoMenu = async (e: React.MouseEvent) => {
    const at = anchor(e);
    const recent = await api
      .settings()
      .then((st) => st.recent ?? [])
      .catch(() => []);
    const tabs = useUi.getState().tabs;
    const others = recent.filter((r) => r.path !== ctx.info.root && !tabs.some((tb) => tb.root === r.path)).slice(0, 12);
    openMenu(at, [
      ...tabs.map((tb) => ({
        label: tb.name,
        icon: tb.root === ctx.info.root ? <CircleDot size={14} /> : <FolderGit2 size={14} />,
        hint: tb.host ?? undefined,
        onClick: () => useUi.getState().setActive(tb.root),
      })),
      ...(others.length ? [{ separator: true }] : []),
      ...others.map((r) => ({ label: r.name, icon: <FolderGit2 size={14} />, hint: r.path.startsWith("ssh://") ? "ssh" : undefined, onClick: () => openRepoPath(r.path) })),
      { separator: true },
      { label: t("저장소 열기…"), icon: <FolderOpen size={14} />, onClick: () => openManager("open") },
      { label: t("저장소 복제…"), icon: <CloudDownload size={14} />, onClick: () => openManager("clone") },
      { label: t("MobyD 링크 복사"), icon: <Link2 size={14} />, hint: "mobyd://", onClick: () => copyText(repoLink(ctx.info.root), t("이 저장소를 여는 링크를 복사했습니다")) },
      ctx.info.host
        ? { label: t("원격 폴더 경로 복사"), icon: <FolderSearch size={14} />, onClick: () => copyText(ctx.info.path) }
        : { label: t("Finder에서 보기"), icon: <FolderSearch size={14} />, onClick: () => revealPath(ctx.info.root) },
    ]);
  };

  const pullMenu = (e: React.MouseEvent) =>
    openMenu(anchor(e), [
      { label: t("Fetch (모든 원격)"), onClick: () => fetchFlow(ctx) },
      { separator: true },
      { label: t("Pull — fast-forward만"), onClick: () => pullFlow(ctx, "ff-only") },
      { label: "Pull — merge", onClick: () => pullFlow(ctx, "merge") },
      { label: "Pull — rebase", onClick: () => pullFlow(ctx, "rebase") },
    ]);

  const pushMenu = (e: React.MouseEvent) =>
    openMenu(anchor(e), [
      { label: "Push", onClick: () => pushFlow(ctx) },
      { label: t("Push 후 풀 리퀘스트 만들기…"), onClick: async () => {
        await pushFlow(ctx);
        await createPrFlow(ctx);
      } },
      { separator: true },
      { label: "Force push (--force-with-lease)…", danger: true, onClick: () => pushFlow(ctx, true) },
    ]);

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <button className="repo-name" title={displayRoot(ctx.info.root)} onClick={repoMenu}>
          {ctx.info.host ? <Server size={14} className="accent" /> : <FolderOpen size={14} />}
          <MidEllipsis text={repoBaseName(ctx.info.name, ctx.info.host)} />
          {ctx.info.host && <span className="host-chip">{ctx.info.host}</span>}
          <ChevronDown size={12} />
        </button>
        <button className="branch-pill" onClick={branchMenu} title={t("브랜치 전환")}>
          <GitBranch size={14} />
          <span>{branchLabel}</span>
          {status && (status.ahead > 0 || status.behind > 0) && (
            <span className="ab">
              {status.ahead > 0 && <>↑{status.ahead}</>} {status.behind > 0 && <>↓{status.behind}</>}
            </span>
          )}
          <ChevronDown size={12} />
        </button>
      </div>

      <div className="toolbar-group center-group">
        <button className="tool" data-tour="undo" onClick={ctx.undo} disabled={!undo?.undo || !!ctx.busy} title={undo?.undo ? t("실행 취소: {undo} (⌘Z)", { undo: undo.undo }) : t("되돌릴 작업 없음")}>
          <Undo2 size={17} />
          <span>{t("실행 취소")}</span>
        </button>
        <button className="tool" data-tour="undo" onClick={ctx.redo} disabled={!undo?.redo || !!ctx.busy} title={undo?.redo ? t("다시 실행: {redo} (⇧⌘Z)", { redo: undo.redo }) : t("다시 실행할 작업 없음")}>
          <Redo2 size={17} />
          <span>{t("다시 실행")}</span>
        </button>
        <span className="tool-sep" />
        <div className="split-btn" data-tour="sync">
          <button className="tool" onClick={() => pullFlow(ctx)} disabled={!!ctx.busy} title={t("최신 변경 받기 (Pull)")}>
            <ArrowDownToLine size={17} />
            <span>Pull</span>
          </button>
          <button className="tool caret" onClick={pullMenu} aria-label={t("Pull 옵션")}>
            <ChevronDown size={11} />
          </button>
        </div>
        <div className="split-btn" data-tour="sync">
          <button className="tool" onClick={() => pushFlow(ctx)} disabled={!!ctx.busy} title={t("내 커밋 올리기 (Push)")}>
            <ArrowUpFromLine size={17} />
            <span>Push</span>
          </button>
          <button className="tool caret" onClick={pushMenu} aria-label={t("Push 옵션")}>
            <ChevronDown size={11} />
          </button>
        </div>
        <span className="tool-sep" />
        <button className="tool" data-tour="tools" onClick={() => createBranchFlow(ctx)} title={t("새 브랜치 만들기")}>
          <GitBranchPlus size={17} />
          <span>{t("브랜치")}</span>
        </button>
        <span className="tool-sep" />
        <button className="tool" data-tour="tools" onClick={() => stashFlow(ctx)} disabled={dirty === 0} title={dirty === 0 ? t("보관할 변경이 없습니다") : t("작업 중인 변경을 잠시 보관 (Stash)")}>
          <Archive size={17} />
          <span>Stash</span>
        </button>
        <button className="tool" data-tour="tools" onClick={() => stashActionFlow(ctx, "pop", 0)} disabled={stashes.length === 0} title={stashes.length === 0 ? t("꺼낼 Stash가 없습니다") : t("마지막 Stash 꺼내기 (Pop)")}>
          <ArchiveRestore size={17} />
          <span>Pop</span>
        </button>
        <span className="tool-sep" />
        <button className="tool" data-tour="tools" onClick={() => addWorktreeFlow(ctx)} title={t("워크트리 추가")}>
          <GitFork size={17} />
          <span>{t("워크트리")}</span>
        </button>
        <button className="tool" data-tour="tools" onClick={() => createPrFlow(ctx)} title={t("풀 리퀘스트 만들기")}>
          <GitPullRequestCreate size={17} />
          <span>PR</span>
        </button>
        <button
          className="tool"
          data-tour="tools"
          onClick={() => api.openTerminal(ctx.info.root).catch((e) => toast.error(t("터미널을 열 수 없습니다"), errorText(e)))}
          title={ctx.info.host ? t("{host}에 ssh로 접속한 터미널", { host: ctx.info.host }) : t("이 폴더에서 터미널 열기")}
        >
          <SquareTerminal size={17} />
          <span>{t("터미널")}</span>
        </button>
      </div>

      <div className="toolbar-group right-group">
        {ctx.busy && (
          <span className="busy">
            <Loader2 size={14} className="spin" /> {ctx.busy}…
          </span>
        )}
        <label className="search">
          <Search size={13} />
          <input
            placeholder={t("커밋 검색 (메시지·작성자·SHA)")}
            value={ctx.filter}
            onChange={(e) => ctx.setFilter(e.target.value)}
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                window.dispatchEvent(new CustomEvent("mobyd-search-step", { detail: { root: ctx.info.root, dir: e.shiftKey ? -1 : 1 } }));
              } else if (e.key === "Escape" && ctx.filter) {
                e.preventDefault();
                ctx.setFilter("");
              }
            }}
          />
          {ctx.filter && (
            <button type="button" className="clear-btn" aria-label={t("검색 지우기")} title={t("검색 지우기")} onClick={() => ctx.setFilter("")}>
              <X size={12} />
            </button>
          )}
        </label>
      </div>
    </div>
  );
}
