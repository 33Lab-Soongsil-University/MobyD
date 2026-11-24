import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  GitBranch,
  GitFork,
  GitPullRequest,
  GitPullRequestDraft,
  GitMerge,
  Archive,
  Tag,
  Plus,
  Lock,
  Server,
  RefreshCw,
  CircleDot,
  Search,
  Trash2,
  FolderOpen,
  LockOpen,
  Eraser,
  X,
  KeyRound,
} from "lucide-react";
import { api, errorText } from "../lib/api";
import type { PullRequest, RefInfo } from "../lib/types";
import { useRepo } from "../repo/RepoContext";
import { DeployKeys } from "./SshKeys";
import {
  addWorktreeFlow,
  checkoutRef,
  connectWithSshKey,
  createBranchFlow,
  createPrFlow,
  refMenu,
  removeWorktreeFlow,
  sshKeyCandidates,
  stashActionFlow,
} from "../repo/actions";
import { ask, confirmAction, openMenu, openPrefs, useUi } from "../store";
import { openRepoPath } from "../lib/actions";
import { isoRelative, relativeTime } from "../lib/format";
import { ForgeIcon } from "./ForgeIcon";
import { t } from "../lib/i18n";

function Section({
  id,
  title,
  icon,
  count,
  actions,
  children,
  defaultOpen = true,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  count?: number;
  actions?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const key = `mobyd.section.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? defaultOpen : v === "1";
    } catch {
      return defaultOpen;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(key, open ? "0" : "1");
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="sb-section">
      <div className="sb-head" onClick={toggle}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {icon}
        <span className="sb-title">{title}</span>
        {count !== undefined && <span className="sb-count">{count}</span>}
        <span className="sb-actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
      </div>
      {open && <div className="sb-body">{children}</div>}
    </div>
  );
}

function BranchItem({ r, label }: { r: RefInfo; label?: string }) {
  const ctx = useRepo();
  const selected = ctx.selected === r.target;
  return (
    <div
      className={"sb-item" + (r.isHead ? " head" : "") + (selected ? " selected" : "")}
      onClick={() => ctx.jumpTo(r.target)}
      onDoubleClick={() => checkoutRef(ctx, r)}
      onContextMenu={(e) => openMenu(e, refMenu(ctx, r))}
      title={`${r.short}\n${r.subject}`}
    >
      {r.isHead ? <CircleDot size={13} className="accent" /> : r.kind === "tag" ? <Tag size={13} /> : <GitBranch size={13} />}
      <span className="sb-label">{label ?? r.short}</span>
      {r.kind === "local" && (r.ahead > 0 || r.behind > 0) && (
        <span className="ab">
          {r.ahead > 0 && <span>↑{r.ahead}</span>}
          {r.behind > 0 && <span>↓{r.behind}</span>}
        </span>
      )}
      {r.kind === "local" && r.upstreamGone && <span className="badge warn">gone</span>}
    </div>
  );
}

function PrSection() {
  const ctx = useRepo();
  const accountsVersion = useUi((s) => s.accountsVersion);
  const forges = ctx.forgeRemotes.filter((r) => r.kind && r.target);
  const [remote, setRemote] = useState<string | null>(null);
  const [state, setState] = useState("open");
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const active = forges.find((f) => f.remote === remote) ?? forges.find((f) => f.remote === "origin") ?? forges[0];

  useEffect(() => {
    if (!active) return;
    let cancel = false;
    setLoading(true);
    api
      .prList(ctx.path, active.remote, state)
      .then((r) => {
        if (!cancel) {
          setPrs(r);
          setErr(null);
        }
      })
      .catch((e) => !cancel && setErr(errorText(e)))
      .finally(() => !cancel && setLoading(false));
    return () => {
      cancel = true;
    };
  }, [ctx.path, active?.remote, state, ctx.prVersion, accountsVersion]);

  return (
    <Section
      id="prs"
      title={active?.kind === "gitlab" ? t("머지 리퀘스트") : t("풀 리퀘스트")}
      icon={<GitPullRequest size={13} />}
      count={active ? prs.length : undefined}
      actions={
        <>
          <button className="icon-btn" title={t("새로고침")} onClick={() => ctx.bumpPrs()}>
            <RefreshCw size={12} className={loading ? "spin" : ""} />
          </button>
          <button className="icon-btn" title={t("PR 만들기")} onClick={() => createPrFlow(ctx)}>
            <Plus size={13} />
          </button>
        </>
      }
    >
      {!active && <p className="sb-empty">{t("GitHub · GitLab · Gitea 원격이 없습니다.")}</p>}
      {active && (
        <div className="sb-filters">
          {forges.length > 1 && (
            <select value={active.remote} onChange={(e) => setRemote(e.target.value)}>
              {forges.map((f) => (
                <option key={f.remote} value={f.remote}>
                  {f.remote}
                </option>
              ))}
            </select>
          )}
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="open">{t("열림")}</option>
            <option value="merged">{t("병합됨")}</option>
            <option value="closed">{t("닫힘")}</option>
            <option value="all">{t("전체")}</option>
          </select>
          <span className="sb-forge" title={active.url}>
            <ForgeIcon kind={active.kind} size={12} /> {active.target?.path}
            {!active.accountId && <em className="muted">{" "}{t("· 익명")}</em>}
          </span>
        </div>
      )}
      {err && (
        <p className="sb-error" title={err}>
          {err}
          {!active?.accountId && (
            <button className="link" onClick={() => openPrefs("integrations")}>{t("계정 연결")}</button>
          )}
        </p>
      )}
      {prs.map((p) => (
        <div
          key={p.number}
          className={"sb-item pr" + (ctx.pr?.number === p.number && ctx.pr.remote === active?.remote ? " selected" : "")}
          onClick={() => active && ctx.selectPr({ remote: active.remote, number: p.number })}
          title={`${p.title}\n${p.sourceBranch} → ${p.targetBranch}`}
        >
          {p.state === "merged" ? (
            <GitMerge size={13} className="purple" />
          ) : p.draft ? (
            <GitPullRequestDraft size={13} className="muted" />
          ) : (
            <GitPullRequest size={13} className={p.state === "open" ? "green" : "red"} />
          )}
          <span className="sb-label">
            <span className="muted">#{p.number}</span> {p.title}
          </span>
          <span className="muted tiny">{isoRelative(p.updatedAt)}</span>
        </div>
      ))}
    </Section>
  );
}

export function Sidebar() {
  const ctx = useRepo();
  const [q, setQ] = useState("");
  const [openRemotes, setOpenRemotes] = useState<Record<string, boolean>>({});
  const refs = ctx.data?.refs ?? [];
  const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
  const locals = useMemo(() => refs.filter((r) => r.kind === "local" && match(r.short)), [refs, q]);
  const tags = useMemo(() => refs.filter((r) => r.kind === "tag" && match(r.short)).sort((a, b) => b.date - a.date), [refs, q]);
  const remotes = useMemo(() => {
    const m = new Map<string, RefInfo[]>();
    for (const r of refs) {
      if (r.kind !== "remote" || !match(r.short)) continue;
      const k = r.remote ?? "?";
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  }, [refs, q]);
  const stashes = ctx.data?.stashes ?? [];
  // Big remotes start collapsed so the sections below stay reachable; filtering opens everything.
  const remoteOpen = (name: string) => !!q || (openRemotes[name] ?? (remotes.get(name)?.length ?? 0) <= 15);

  const addRemote = async () => {
    const v = await ask({
      title: t("원격 추가"),
      fields: [
        { name: "name", label: t("이름"), value: ctx.forgeRemotes.length ? "upstream" : "origin", required: true, mono: true },
        { name: "url", label: "URL", placeholder: "git@github.com:pod/mobyd.git", required: true, mono: true },
      ],
      confirmLabel: t("추가"),
    });
    if (v) await ctx.run(t("원격 추가"), () => api.addRemote(ctx.path, String(v.name).trim(), String(v.url).trim()), { success: t("원격을 추가했습니다") });
  };

  return (
    <div className="sidebar-inner">
      <label className="sb-search">
        <Search size={12} />
        <input
          placeholder={t("브랜치·태그 필터")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Escape" && q) {
              e.preventDefault();
              setQ("");
            }
          }}
        />
        {q && (
          <button type="button" className="clear-btn" aria-label={t("검색 지우기")} title={t("검색 지우기")} onClick={() => setQ("")}>
            <X size={12} />
          </button>
        )}
      </label>
      <div className="sb-scroll">
        <Section
          id="local"
          title={t("로컬")}
          icon={<GitBranch size={13} />}
          count={locals.length}
          actions={
            <button className="icon-btn" title={t("새 브랜치")} onClick={() => createBranchFlow(ctx)}>
              <Plus size={13} />
            </button>
          }
        >
          {locals.length === 0 && <p className="sb-empty">{t("브랜치가 없습니다.")}</p>}
          {locals.map((r) => (
            <BranchItem key={r.name} r={r} />
          ))}
        </Section>

        <Section
          id="remote"
          title={t("원격")}
          icon={<Cloud size={13} />}
          count={[...remotes.values()].reduce((n, l) => n + l.length, 0)}
          actions={
            <button className="icon-btn" title={t("원격 추가")} onClick={addRemote}>
              <Plus size={13} />
            </button>
          }
        >
          {ctx.forgeRemotes.length === 0 && <p className="sb-empty">{t("원격이 없습니다. 로컬 전용 저장소입니다.")}</p>}
          {ctx.forgeRemotes.map((fr) => (
            <div key={fr.remote}>
              <div
                className="sb-item sb-remote"
                title={fr.url}
                onClick={() => setOpenRemotes((m) => ({ ...m, [fr.remote]: !remoteOpen(fr.remote) }))}
                onContextMenu={(e) =>
                  openMenu(e, [
                    { label: `${fr.remote} fetch`, icon: <RefreshCw size={14} />, onClick: () => ctx.run("Fetch", () => api.fetch(ctx.path, fr.remote), { success: t("{remote} fetch 완료", { remote: fr.remote }) }) },
                    ...(fr.target && fr.accountId
                      ? [
                          {
                            label: t("배포 키…"),
                            icon: <KeyRound size={14} />,
                            onClick: () =>
                              void ask({
                                title: t("배포 키 · {repo}", { repo: fr.target!.path }),
                                message: <DeployKeys repo={ctx.path} remote={fr.remote} />,
                                confirmLabel: t("닫기"),
                                infoOnly: true,
                                wide: true,
                              }),
                          },
                        ]
                      : []),
                    ...(sshKeyCandidates(ctx).some((r) => r.remote === fr.remote)
                      ? [{ label: t("SSH 키로 연결…"), icon: <KeyRound size={14} />, onClick: () => connectWithSshKey(ctx, fr.remote) }]
                      : []),
                    {
                      label: t("원격 제거…"),
                      icon: <Trash2 size={14} />,
                      danger: true,
                      onClick: async () => {
                        if (await confirmAction(t("원격 제거"), t("원격 '{remote}' 설정과 원격 추적 브랜치를 지웁니다.", { remote: fr.remote }), t("제거"), true))
                          await ctx.run(t("원격 제거"), () => api.removeRemote(ctx.path, fr.remote), { success: t("원격을 제거했습니다") });
                      },
                    },
                  ])
                }
              >
                {remoteOpen(fr.remote) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {fr.kind ? <ForgeIcon kind={fr.kind} size={13} /> : <Server size={13} />}
                <span className="sb-label">{fr.remote}</span>
                <span className="muted tiny ellipsis">{fr.target?.path ?? fr.url}</span>
              </div>
              {remoteOpen(fr.remote) && (remotes.get(fr.remote) ?? []).map((r) => (
                <div key={r.name} className="indent">
                  <BranchItem r={r} label={r.short.slice(fr.remote.length + 1)} />
                </div>
              ))}
            </div>
          ))}
        </Section>

        <Section
          id="worktrees"
          title={t("워크트리")}
          icon={<GitFork size={13} />}
          count={ctx.worktrees.length}
          actions={
            <>
              <button
                className="icon-btn"
                title={t("정리 (prune)")}
                onClick={() => ctx.run(t("워크트리 정리"), () => api.pruneWorktrees(ctx.path), { success: t("사라진 워크트리 기록을 정리했습니다") })}
              >
                <Eraser size={12} />
              </button>
              <button className="icon-btn" title={t("워크트리 추가")} onClick={() => addWorktreeFlow(ctx)}>
                <Plus size={13} />
              </button>
            </>
          }
        >
          {ctx.worktrees.map((w) => (
            <div
              key={w.path}
              className={"sb-item" + (w.isCurrent ? " head" : "")}
              title={w.path}
              onDoubleClick={() => !w.isCurrent && openRepoPath(w.openPath)}
              onClick={() => w.head && ctx.rowIndex.has(w.head) && ctx.jumpTo(w.head)}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: t("새 탭으로 열기"), icon: <FolderOpen size={14} />, disabled: w.isCurrent || w.prunable, onClick: () => openRepoPath(w.openPath) },
                  w.locked
                    ? { label: t("잠금 해제"), icon: <LockOpen size={14} />, onClick: () => ctx.run(t("잠금 해제"), () => api.lockWorktree(ctx.path, w.path, false)) }
                    : { label: t("잠그기"), icon: <Lock size={14} />, disabled: w.isMain, onClick: () => ctx.run(t("잠그기"), () => api.lockWorktree(ctx.path, w.path, true)) },
                  { separator: true },
                  { label: t("워크트리 제거…"), icon: <Trash2 size={14} />, danger: true, disabled: w.isMain || w.isCurrent, onClick: () => removeWorktreeFlow(ctx, w) },
                ])
              }
            >
              {w.isCurrent ? <CircleDot size={13} className="accent" /> : <GitFork size={13} />}
              <span className="sb-label">
                {w.branch ?? (w.detached ? t("(분리됨) {head}", { head: w.head?.slice(0, 7) }) : w.bare ? "(bare)" : "?")}
                {w.isMain && (
                  <span className="badge" title={t("기본 워크트리 (저장소 폴더)")}>{t("기본")}</span>
                )}
              </span>
              {w.locked && <Lock size={11} className="muted" />}
              {w.prunable && <span className="badge warn">{t("없음")}</span>}
            </div>
          ))}
        </Section>

        <Section id="stash" title="Stash" icon={<Archive size={13} />} count={stashes.length} defaultOpen={stashes.length > 0}>
          {stashes.length === 0 && <p className="sb-empty">{t("보관된 변경이 없습니다.")}</p>}
          {stashes.map((s) => (
            <div
              key={s.name}
              className={"sb-item" + (ctx.selected === s.name ? " selected" : "")}
              title={s.message}
              onClick={() => ctx.rowIndex.has(s.name) ? ctx.jumpTo(s.name) : ctx.select(s.hash)}
              onDoubleClick={() => stashActionFlow(ctx, "apply", s.index)}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: t("적용 (apply)"), onClick: () => stashActionFlow(ctx, "apply", s.index) },
                  { label: t("꺼내기 (pop)"), onClick: () => stashActionFlow(ctx, "pop", s.index) },
                  { separator: true },
                  { label: t("삭제…"), danger: true, icon: <Trash2 size={14} />, onClick: () => stashActionFlow(ctx, "drop", s.index) },
                ])
              }
            >
              <Archive size={13} />
              <span className="sb-label">{s.message}</span>
              <span className="muted tiny">{relativeTime(s.time)}</span>
            </div>
          ))}
        </Section>

        <PrSection />


        <Section id="tags" title={t("태그")} icon={<Tag size={13} />} count={tags.length} defaultOpen={false}>
          {tags.length === 0 && <p className="sb-empty">{t("태그가 없습니다.")}</p>}
          {tags.map((r) => (
            <BranchItem key={r.name} r={r} />
          ))}
        </Section>
      </div>
    </div>
  );
}
