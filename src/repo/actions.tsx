import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Cherry,
  Copy,
  ExternalLink,
  GitBranchPlus,
  GitFork,
  GitMerge,
  GitPullRequestCreate,
  History,
  LogIn,
  Pencil,
  RotateCcw,
  Tag,
  Trash2,
  Undo2,
  Workflow,
  Waves,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, rawErrorText } from "../lib/api";
import type { Commit, ForgeRemote, RefInfo, Worktree } from "../lib/types";
import { ask, confirmAction, toast, type MenuItem } from "../store";
import { copyText, openRepoPath, sshUri } from "../lib/actions";
import { basename, dirname, joinPath } from "../lib/format";
import { CANCELLED, WIP, type RepoCtx } from "./RepoContext";
import { t } from "../lib/i18n";
import { tj } from "../lib/i18n-react";

const I = 14;

export function currentBranch(ctx: RepoCtx): string | null {
  return ctx.data?.head.branch ?? null;
}

function localBranches(ctx: RepoCtx) {
  return (ctx.data?.refs ?? []).filter((r) => r.kind === "local");
}

function remoteBranches(ctx: RepoCtx) {
  return (ctx.data?.refs ?? []).filter((r) => r.kind === "remote");
}

export function defaultRemote(ctx: RepoCtx): ForgeRemote | null {
  const fr = ctx.forgeRemotes;
  return fr.find((r) => r.remote === "origin") ?? fr[0] ?? null;
}

export function guessBaseBranch(ctx: RepoCtx, remote: string | null): string {
  const names = new Set(
    remoteBranches(ctx)
      .filter((r) => !remote || r.remote === remote)
      .map((r) => r.short.slice((r.remote?.length ?? 0) + 1)),
  );
  const locals = new Set(localBranches(ctx).map((r) => r.short));
  for (const n of ["main", "master", "develop", "trunk"]) if (names.has(n) || locals.has(n)) return n;
  return [...names][0] ?? [...locals][0] ?? "main";
}

// ----- flows ------------------------------------------------------------------

/**
 * Run a checkout; when uncommitted changes block it, offer to stash them and
 * switch anyway (GitKraken's "stash and checkout"). Pop brings them back.
 */
function withStashOffer<T>(ctx: RepoCtx, target: string, checkout: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await checkout();
    } catch (e) {
      if (!blockedByLocalChanges(rawErrorText(e))) throw e;
      const ok = await confirmAction(
        t("커밋하지 않은 변경이 있습니다"),
        t("변경을 Stash에 보관하고 '{target}'(으)로 체크아웃할까요? 보관한 변경은 툴바의 Pop으로 다시 꺼낼 수 있습니다.", { target }),
        t("Stash하고 체크아웃"),
      );
      if (!ok) throw CANCELLED;
      await api.stashSave(ctx.path, t("'{target}'(으)로 전환하기 전 자동 보관", { target }), true);
      return await checkout();
    }
  };
}

/** git refused to switch because uncommitted (or untracked) files would be overwritten. */
export function blockedByLocalChanges(raw: string): boolean {
  return /would be overwritten by (checkout|switch)|commit your changes or stash them before you switch/i.test(raw);
}

export async function checkoutRef(ctx: RepoCtx, ref: RefInfo) {
  if (ref.kind === "local") {
    if (ref.isHead) return;
    await ctx.run(t("'{short}' 체크아웃", { short: ref.short }), withStashOffer(ctx, ref.short, () => api.checkout(ctx.path, ref.short)), {
      success: t("'{short}'(으)로 전환했습니다", { short: ref.short }),
    });
  } else if (ref.kind === "remote") {
    const local = ref.short.slice((ref.remote?.length ?? 0) + 1);
    await ctx.run(t("'{short}' 체크아웃", { short: ref.short }), withStashOffer(ctx, local, () => api.checkout(ctx.path, ref.short, true, local)), {
      success: t("로컬 브랜치 '{local}'(으)로 전환했습니다", { local }),
    });
  } else {
    await ctx.run(t("태그 '{short}' 체크아웃", { short: ref.short }), withStashOffer(ctx, ref.short, () => api.checkoutDetached(ctx.path, ref.short)), {
      success: t("분리된 HEAD 상태로 전환했습니다"),
    });
  }
}

export async function createBranchFlow(ctx: RepoCtx, start?: string | null, startLabel?: string) {
  const v = await ask({
    title: t("새 브랜치"),
    message: startLabel ? t("시작 지점: {startLabel}", { startLabel }) : t("현재 HEAD에서 브랜치를 만듭니다."),
    fields: [
      { name: "name", label: t("브랜치 이름"), placeholder: "feature/echolocation", required: true, mono: true },
      { name: "checkout", label: t("만든 뒤 체크아웃"), type: "checkbox", value: true },
    ],
    confirmLabel: t("만들기"),
  });
  if (!v) return;
  const name = String(v.name).trim();
  const create = () => api.createBranch(ctx.path, name, start ?? null, Boolean(v.checkout));
  await ctx.run(t("브랜치 만들기"), v.checkout ? withStashOffer(ctx, name, create) : create, {
    success: t("브랜치 '{name}'을(를) 만들었습니다", { name }),
  });
}

export async function createTagFlow(ctx: RepoCtx, sha: string) {
  const v = await ask({
    title: t("태그 만들기"),
    message: t("커밋 {sha}", { sha: sha.slice(0, 8) }),
    fields: [
      { name: "name", label: t("태그 이름"), placeholder: "v1.0.0", required: true, mono: true },
      { name: "message", label: t("메시지 (입력하면 annotated 태그)"), type: "textarea" },
      { name: "push", label: t("만든 뒤 원격에 push"), type: "checkbox", value: false },
    ],
    confirmLabel: t("만들기"),
  });
  if (!v) return;
  const name = String(v.name).trim();
  const r = await ctx.run(t("태그 만들기"), () => api.createTag(ctx.path, name, sha, String(v.message || "") || null), {
    success: t("태그 '{name}'을(를) 만들었습니다", { name }),
  });
  const remote = defaultRemote(ctx);
  if (r !== undefined && v.push && remote) {
    await ctx.run(t("태그 push"), () => api.pushTag(ctx.path, remote.remote, name), { success: t("{remote}에 태그를 올렸습니다", { remote: remote.remote }) });
  }
}

export async function mergeFlow(ctx: RepoCtx, rev: string, label = rev) {
  const cur = currentBranch(ctx) ?? "HEAD";
  const v = await ask({
    title: t("병합"),
    message: (
      <>
        {tj("{source}을(를) {target}에 병합합니다.", { source: <b>{label}</b>, target: <b>{cur}</b> })}</>
    ),
    fields: [
      {
        name: "mode",
        label: t("병합 방식"),
        type: "select",
        options: [
          { value: "ff", label: t("기본 (가능하면 fast-forward)") },
          { value: "no-ff", label: t("항상 병합 커밋 만들기 (--no-ff)") },
          { value: "ff-only", label: t("fast-forward만 (--ff-only)") },
          { value: "squash", label: t("스쿼시 (변경만 스테이징)") },
        ],
      },
    ],
    confirmLabel: t("병합"),
  });
  if (!v) return;
  await ctx.runOp(t("병합"), () => api.merge(ctx.path, rev, String(v.mode)), t("{label} → {cur} 병합 완료", { label, cur }));
}

export async function rebaseFlow(ctx: RepoCtx, onto: string, label = onto) {
  const cur = currentBranch(ctx) ?? "HEAD";
  const ok = await confirmAction(
    t("리베이스"),
    <>
      {tj("{branch}의 커밋을 {onto} 위로 옮깁니다. 이미 push한 브랜치라면 force push가 필요합니다.", { branch: <b>{cur}</b>, onto: <b>{label}</b> })}</>,
    t("리베이스"),
  );
  if (ok) await ctx.runOp(t("리베이스"), () => api.rebase(ctx.path, onto), t("{cur}을(를) {label} 위로 리베이스했습니다", { cur, label }));
}

export async function resetFlow(ctx: RepoCtx, sha: string, mode: "soft" | "mixed" | "hard") {
  const cur = currentBranch(ctx) ?? "HEAD";
  const desc = {
    soft: t("변경 내용은 스테이징된 상태로 남습니다."),
    mixed: t("변경 내용은 작업 트리에 남고 스테이징만 풀립니다."),
    hard: t("커밋되지 않은 변경 내용과 이후 커밋이 모두 사라집니다. 되돌리기 어렵습니다."),
  }[mode];
  const ok = await confirmAction(t("{cur} 을(를) 이 커밋으로 reset ({mode})", { cur, mode }), desc, "Reset", mode === "hard");
  if (ok) await ctx.run("Reset", () => api.reset(ctx.path, sha, mode), { success: t("{sha}(으)로 reset ({mode})", { sha: sha.slice(0, 8), mode }) });
}

export async function deleteBranchFlow(ctx: RepoCtx, ref: RefInfo) {
  if (ref.kind === "remote") {
    const branch = ref.short.slice((ref.remote?.length ?? 0) + 1);
    const ok = await confirmAction(t("원격 브랜치 삭제"), t("{remote} 서버에서 '{branch}' 브랜치를 삭제합니다.", { remote: ref.remote, branch }), t("삭제"), true);
    if (ok)
      await ctx.run(t("원격 브랜치 삭제"), () => api.deleteRemoteBranch(ctx.path, ref.remote!, branch), {
        success: t("{short} 삭제됨", { short: ref.short }),
      });
    return;
  }
  const v = await ask({
    title: t("브랜치 삭제"),
    message: t("로컬 브랜치 '{short}'을(를) 삭제합니다.", { short: ref.short }),
    fields: [{ name: "force", label: t("병합되지 않았어도 강제로 삭제 (-D)"), type: "checkbox" }],
    confirmLabel: t("삭제"),
    danger: true,
  });
  if (v) await ctx.run(t("브랜치 삭제"), () => api.deleteBranch(ctx.path, ref.short, Boolean(v.force)), { success: t("'{short}' 삭제됨", { short: ref.short }) });
}

export async function renameBranchFlow(ctx: RepoCtx, ref: RefInfo) {
  const v = await ask({
    title: t("브랜치 이름 바꾸기"),
    fields: [{ name: "name", label: t("새 이름"), value: ref.short, required: true, mono: true }],
    confirmLabel: t("바꾸기"),
  });
  if (v) await ctx.run(t("이름 바꾸기"), () => api.renameBranch(ctx.path, ref.short, String(v.name).trim()), { success: t("이름을 바꿨습니다") });
}

export async function setUpstreamFlow(ctx: RepoCtx, ref: RefInfo) {
  const remotes = remoteBranches(ctx);
  if (remotes.length === 0) return toast.warning(t("원격 브랜치가 없습니다"));
  const v = await ask({
    title: t("'{short}' 업스트림 설정", { short: ref.short }),
    fields: [
      {
        name: "up",
        label: t("추적할 원격 브랜치"),
        type: "select",
        value: ref.upstream ?? remotes.find((r) => r.short.endsWith("/" + ref.short))?.short ?? remotes[0].short,
        options: remotes.map((r) => ({ value: r.short, label: r.short })),
      },
    ],
  });
  if (v) await ctx.run(t("업스트림 설정"), () => api.setUpstream(ctx.path, ref.short, String(v.up)), { success: t("업스트림을 설정했습니다") });
}

export async function fetchFlow(ctx: RepoCtx) {
  await ctx.run("Fetch", () => api.fetch(ctx.path), { success: t("모든 원격을 가져왔습니다 (fetch --all --prune)") });
}

export async function pullFlow(ctx: RepoCtx, mode: "ff-only" | "merge" | "rebase" = "ff-only") {
  const label = { "ff-only": "Pull (fast-forward)", merge: "Pull (merge)", rebase: "Pull (rebase)" }[mode];
  await ctx.runOp(label, () => api.pull(ctx.path, mode), t("최신 변경을 받아왔습니다"));
}

export async function pushFlow(ctx: RepoCtx, force = false) {
  const branch = currentBranch(ctx);
  if (!branch) return toast.warning(t("분리된 HEAD는 push할 수 없습니다"), t("먼저 브랜치를 만드세요."));
  const local = localBranches(ctx).find((r) => r.short === branch);
  if (local?.upstream && !local.upstreamGone) {
    if (force) {
      const ok = await confirmAction("Force push", t("--force-with-lease 로 '{branch}' 를 덮어씁니다.", { branch }), "Force push", true);
      if (!ok) return;
    }
    await ctx.run("Push", () => api.push(ctx.path, { force }), { success: t("'{branch}' push 완료", { branch }) });
    return;
  }
  const remotes = await api.remotes(ctx.path);
  if (remotes.length === 0) return toast.warning(t("원격 저장소가 없습니다"), t("사이드바의 원격 섹션에서 원격을 추가하세요."));
  const v = await ask({
    title: t("업스트림 브랜치 설정 후 push"),
    message: t("'{branch}' 는 아직 원격 브랜치와 연결되어 있지 않습니다.", { branch }),
    fields: [
      {
        name: "remote",
        label: t("원격"),
        type: "select",
        value: remotes.find((r) => r.name === "origin")?.name ?? remotes[0].name,
        options: remotes.map((r) => ({ value: r.name, label: `${r.name} — ${r.pushUrl || r.fetchUrl}` })),
      },
      { name: "branch", label: t("원격 브랜치 이름"), value: branch, required: true, mono: true },
    ],
    confirmLabel: "Push",
  });
  if (!v) return;
  await ctx.run(
    "Push",
    () => api.push(ctx.path, { remote: String(v.remote), branch: String(v.branch), setUpstream: true, force }),
    { success: t("{remote}/{branch} 로 push 했습니다", { remote: v.remote, branch: v.branch }) },
  );
}

export async function stashFlow(ctx: RepoCtx) {
  const v = await ask({
    title: t("변경 사항 stash"),
    fields: [
      { name: "message", label: t("메시지 (선택)"), placeholder: t("WIP: 꼬리 브랜치 다듬기") },
      { name: "untracked", label: t("추적하지 않는 파일 포함"), type: "checkbox", value: true },
    ],
    confirmLabel: "Stash",
  });
  if (v)
    await ctx.run("Stash", () => api.stashSave(ctx.path, String(v.message || "") || null, Boolean(v.untracked)), {
      success: t("변경 사항을 stash에 보관했습니다"),
    });
}

export async function stashActionFlow(ctx: RepoCtx, action: "apply" | "pop" | "drop", index: number) {
  if (action === "drop") {
    const ok = await confirmAction(t("Stash 삭제"), t("stash@{{index}} 를 삭제합니다.", { index }), t("삭제"), true);
    if (!ok) return;
  }
  const label = { apply: t("Stash 적용"), pop: "Stash pop", drop: t("Stash 삭제") }[action];
  await ctx.runOp(label, () => api.stashAction(ctx.path, action, index), t("{label} 완료", { label }));
}

export async function addWorktreeFlow(ctx: RepoCtx, branch?: string | null, start?: string | null) {
  const repoName = basename(ctx.info.path);
  const parent = dirname(ctx.info.path);
  const locals = localBranches(ctx).filter((r) => !ctx.worktrees.some((w) => w.branch === r.short));
  const suggested = (b: string) => joinPath(parent, `${repoName}-${b.replace(/[\\/]/g, "-")}`);
  const mode = branch && locals.some((l) => l.short === branch) ? "existing" : branch ? "new" : start ? "new" : locals.length ? "existing" : "new";
  const v = await ask({
    title: t("워크트리 추가"),
    message: t("같은 저장소의 다른 브랜치를 별도 폴더에서 동시에 작업합니다."),
    wide: true,
    fields: [
      {
        name: "mode",
        label: t("방식"),
        type: "select",
        value: mode,
        options: [
          { value: "existing", label: t("기존 브랜치 체크아웃") },
          { value: "new", label: t("새 브랜치 만들기") },
          { value: "detach", label: t("분리된 HEAD (특정 커밋)") },
        ],
      },
      {
        name: "branch",
        label: t("브랜치"),
        type: "select",
        value: branch && locals.some((l) => l.short === branch) ? branch : locals[0]?.short ?? "",
        options: locals.map((l) => ({ value: l.short, label: l.short })),
        showWhen: { field: "mode", equals: ["existing"] },
      },
      {
        name: "newBranch",
        label: t("새 브랜치 이름"),
        value: branch && !locals.some((l) => l.short === branch) ? branch : "",
        placeholder: "feature/pod",
        mono: true,
        showWhen: { field: "mode", equals: ["new"] },
      },
      {
        name: "start",
        label: t("시작 지점 (비우면 HEAD)"),
        value: start ?? "",
        placeholder: t("main, origin/main, 커밋 SHA…"),
        mono: true,
        showWhen: { field: "mode", equals: ["new", "detach"] },
      },
      {
        name: "path",
        label: t("폴더 경로"),
        value: suggested(branch ?? locals[0]?.short ?? "worktree"),
        derive: (v) =>
          suggested(
            String(v.mode === "existing" ? v.branch : v.mode === "new" ? v.newBranch || "new-branch" : String(v.start || "detached").slice(0, 12)),
          ),
        required: true,
        mono: true,
        browse: "directory",
        hint: t("비어 있거나 존재하지 않는 폴더여야 합니다."),
      },
      { name: "open", label: t("만든 뒤 새 탭으로 열기"), type: "checkbox", value: true },
    ],
    confirmLabel: t("워크트리 만들기"),
  });
  if (!v) return;
  const m = String(v.mode);
  const req =
    m === "existing"
      ? { path: String(v.path), branch: String(v.branch) }
      : m === "new"
        ? { path: String(v.path), branch: String(v.newBranch).trim(), newBranch: true, start: String(v.start || "") || null }
        : { path: String(v.path), detach: true, start: String(v.start || "") || null };
  const r = await ctx.run(t("워크트리 추가"), () => api.addWorktree(ctx.path, req), { success: t("워크트리를 만들었습니다: {path}", { path: v.path }) });
  if (r !== undefined && v.open) await openRepoPath(ctx.info.host ? sshUri(ctx.info.host, String(v.path)) : String(v.path));
}

export async function removeWorktreeFlow(ctx: RepoCtx, wt: Worktree) {
  const v = await ask({
    title: t("워크트리 제거"),
    message: t("{path} 폴더를 워크트리에서 제거합니다. 브랜치는 남습니다.", { path: wt.path }),
    fields: [
      { name: "force", label: t("커밋하지 않은 변경이 있어도 강제로 제거"), type: "checkbox" },
      ...(wt.branch ? [{ name: "deleteBranch", label: t("브랜치 '{branch}'도 삭제", { branch: wt.branch }), type: "checkbox" as const }] : []),
    ],
    confirmLabel: t("제거"),
    danger: true,
  });
  if (!v) return;
  const removed = await ctx.run(t("워크트리 제거"), () => api.removeWorktree(ctx.path, wt.path, Boolean(v.force)), {
    success: t("워크트리를 제거했습니다"),
    reload: !v.deleteBranch,
  });
  if (removed !== undefined && v.deleteBranch && wt.branch) {
    await ctx.run(t("브랜치 삭제"), () => api.deleteBranch(ctx.path, wt.branch!, Boolean(v.force)), { success: t("'{branch}' 삭제됨", { branch: wt.branch }) });
  }
}

export function openOnForge(ctx: RepoCtx, sub: (base: string, kind: string) => string) {
  const r = defaultRemote(ctx);
  if (!r?.repoUrl || !r.kind) return toast.warning(t("호스팅 서비스 주소를 알 수 없습니다"));
  openUrl(sub(r.repoUrl, r.kind)).catch(() => {});
}

export async function createPrFlow(ctx: RepoCtx, source?: string | null) {
  const forges = ctx.forgeRemotes.filter((r) => r.kind && r.target);
  if (forges.length === 0) {
    return toast.warning(t("PR을 만들 수 있는 원격이 없습니다"), t("GitHub/GitLab/Gitea 원격을 추가하고 계정을 연결하세요."));
  }
  const def = defaultRemote(ctx) && forges.includes(defaultRemote(ctx)!) ? defaultRemote(ctx)! : forges[0];
  const src = source ?? currentBranch(ctx) ?? localBranches(ctx)[0]?.short ?? "";
  const target = guessBaseBranch(ctx, def.remote);
  const head = ctx.data?.commits.find((c) => c.hash === localBranches(ctx).find((b) => b.short === src)?.target);
  const branchOptions = Array.from(
    new Set([
      ...localBranches(ctx).map((r) => r.short),
      ...remoteBranches(ctx)
        .filter((r) => r.remote === def.remote)
        .map((r) => r.short.slice(def.remote.length + 1)),
    ]),
  ).map((b) => ({ value: b, label: b }));
  const v = await ask({
    title: t("풀 리퀘스트 만들기"),
    wide: true,
    fields: [
      {
        name: "remote",
        label: t("원격 저장소"),
        type: "select",
        value: def.remote,
        options: forges.map((f) => ({ value: f.remote, label: `${f.remote} · ${f.kind} · ${f.target?.path}` })),
      },
      { name: "source", label: t("원본 브랜치 (head)"), type: "select", value: src, options: branchOptions },
      { name: "target", label: t("대상 브랜치 (base)"), type: "select", value: target, options: branchOptions },
      { name: "title", label: t("제목"), value: head?.subject ?? src, required: true },
      { name: "body", label: t("설명"), type: "textarea", placeholder: t("무엇을, 왜 바꿨는지 적어주세요.") },
      { name: "draft", label: t("초안(Draft)으로 만들기"), type: "checkbox" },
      { name: "push", label: t("원본 브랜치를 먼저 push"), type: "checkbox", value: true, hint: t("원격에 이미 최신 상태면 아무 일도 일어나지 않습니다.") },
    ],
    confirmLabel: t("PR 만들기"),
  });
  if (!v) return;
  const remote = String(v.remote);
  const sourceBranch = String(v.source);
  if (v.push && localBranches(ctx).some((b) => b.short === sourceBranch)) {
    const isCurrent = currentBranch(ctx) === sourceBranch;
    const pushed = await ctx.run(
      "Push",
      () =>
        isCurrent
          ? api.push(ctx.path, { remote, branch: sourceBranch, setUpstream: true })
          : api.push(ctx.path, { remote, branch: null }).then(() => ""),
      { quiet: true, reload: false },
    );
    if (pushed === undefined) return;
  }
  const pr = await ctx.run(
    t("PR 만들기"),
    () =>
      api.prCreate(ctx.path, remote, {
        title: String(v.title),
        body: String(v.body || ""),
        sourceBranch,
        targetBranch: String(v.target),
        draft: Boolean(v.draft),
      }),
    { success: (p) => `#${p.number} ${p.title}` },
  );
  if (pr) {
    ctx.bumpPrs();
    ctx.selectPr({ remote, number: pr.number });
  }
}

// ----- menus --------------------------------------------------------------------

export function refMenu(ctx: RepoCtx, ref: RefInfo): MenuItem[] {
  const cur = currentBranch(ctx);
  const isCurrent = ref.kind === "local" && ref.isHead;
  const name = ref.short;
  const items: MenuItem[] = [];
  if (!isCurrent) items.push({ label: t("'{name}' 체크아웃", { name }), icon: <LogIn size={I} />, onClick: () => checkoutRef(ctx, ref) });
  if (isCurrent) {
    items.push({ label: "Pull", icon: <ArrowDownToLine size={I} />, onClick: () => pullFlow(ctx) });
    items.push({ label: "Push", icon: <ArrowUpFromLine size={I} />, onClick: () => pushFlow(ctx) });
  }
  if (ref.kind !== "tag" && cur && !isCurrent) {
    items.push({ separator: true });
    items.push({ label: t("'{name}' → '{cur}' 병합", { name, cur }), icon: <GitMerge size={I} />, onClick: () => mergeFlow(ctx, ref.short) });
    items.push({ label: t("'{cur}'을(를) '{name}' 위로 리베이스", { cur, name }), icon: <Workflow size={I} />, onClick: () => rebaseFlow(ctx, ref.short) });
  }
  items.push({ separator: true });
  items.push({ label: t("여기서 새 브랜치"), icon: <GitBranchPlus size={I} />, onClick: () => createBranchFlow(ctx, ref.short, name) });
  if (ref.kind !== "tag") {
    items.push({
      label: t("워크트리로 열기…"),
      icon: <GitFork size={I} />,
      onClick: () =>
        ref.kind === "local" ? addWorktreeFlow(ctx, ref.short) : addWorktreeFlow(ctx, ref.short.slice((ref.remote?.length ?? 0) + 1), ref.short),
    });
    items.push({
      label: t("풀 리퀘스트 만들기…"),
      icon: <GitPullRequestCreate size={I} />,
      onClick: () => createPrFlow(ctx, ref.kind === "local" ? ref.short : ref.short.slice((ref.remote?.length ?? 0) + 1)),
    });
  }
  if (ref.kind === "local" && !isCurrent && ref.upstream && ref.behind > 0 && ref.ahead === 0) {
    items.splice(1, 0, {
      label: t("'{upstream}'(으)로 fast-forward", { upstream: ref.upstream }),
      icon: <ArrowDownToLine size={I} />,
      hint: `↓${ref.behind}`,
      onClick: () =>
        ctx.run("Fast-forward", () => api.fastForward(ctx.path, ref.short, ref.upstream!), { success: t("'{short}'을(를) {behind}개 커밋 앞으로 옮겼습니다", { short: ref.short, behind: ref.behind }) }),
    });
  }
  if (ref.kind === "local") {
    items.push({ separator: true });
    items.push({ label: t("업스트림 설정…"), icon: <Waves size={I} />, onClick: () => setUpstreamFlow(ctx, ref) });
    items.push({ label: t("이름 바꾸기…"), icon: <Pencil size={I} />, onClick: () => renameBranchFlow(ctx, ref) });
    items.push({ label: t("삭제…"), icon: <Trash2 size={I} />, danger: true, disabled: isCurrent, onClick: () => deleteBranchFlow(ctx, ref) });
  } else if (ref.kind === "remote") {
    items.push({ separator: true });
    items.push({ label: t("원격에서 삭제…"), icon: <Trash2 size={I} />, danger: true, onClick: () => deleteBranchFlow(ctx, ref) });
  } else {
    const remote = defaultRemote(ctx);
    items.push({ separator: true });
    if (remote)
      items.push({
        label: t("{remote}에 태그 push", { remote: remote.remote }),
        icon: <ArrowUpFromLine size={I} />,
        onClick: () => ctx.run(t("태그 push"), () => api.pushTag(ctx.path, remote.remote, ref.short), { success: t("태그를 push 했습니다") }),
      });
    items.push({
      label: t("태그 삭제"),
      icon: <Trash2 size={I} />,
      danger: true,
      onClick: async () => {
        if (await confirmAction(t("태그 삭제"), t("로컬 태그 '{short}'을(를) 삭제합니다.", { short: ref.short }), t("삭제"), true))
          await ctx.run(t("태그 삭제"), () => api.deleteTag(ctx.path, ref.short), { success: t("태그를 삭제했습니다") });
      },
    });
  }
  items.push({ separator: true });
  items.push({ label: t("이름 복사"), icon: <Copy size={I} />, onClick: () => copyText(ref.short) });
  return items;
}

export function commitMenu(ctx: RepoCtx, c: Commit): MenuItem[] {
  if (c.kind === "wip") {
    return [
      { label: t("모두 스테이징"), onClick: () => ctx.run(t("스테이징"), () => api.stage(ctx.path, []), { quiet: true }) },
      { label: "Stash…", icon: <History size={I} />, onClick: () => stashFlow(ctx) },
      { separator: true },
      {
        label: t("모든 변경 버리기…"),
        icon: <Trash2 size={I} />,
        danger: true,
        onClick: async () => {
          if (await confirmAction(t("모든 변경 버리기"), t("스테이징 여부와 관계없이 모든 변경과 새 파일이 사라집니다."), t("모두 버리기"), true)) {
            const st = ctx.data?.status;
            await ctx.run(t("변경 버리기"), async () => {
              await api.unstage(ctx.path, []);
              const s = await api.status(ctx.path);
              await api.discard(
                ctx.path,
                s.unstaged.filter((f) => f.status !== "?").map((f) => f.path),
                s.unstaged.filter((f) => f.status === "?").map((f) => f.path),
              );
              return st;
            });
          }
        },
      },
    ];
  }
  if (c.kind === "stash") {
    const index = Number(c.hash.match(/\d+/)?.[0] ?? 0);
    return [
      { label: t("Stash 적용"), onClick: () => stashActionFlow(ctx, "apply", index) },
      { label: "Stash pop", onClick: () => stashActionFlow(ctx, "pop", index) },
      { separator: true },
      { label: t("Stash 삭제…"), icon: <Trash2 size={I} />, danger: true, onClick: () => stashActionFlow(ctx, "drop", index) },
    ];
  }
  const cur = currentBranch(ctx) ?? "HEAD";
  const short = c.hash.slice(0, 8);
  return [
    { label: t("이 커밋 체크아웃 (분리된 HEAD)"), icon: <LogIn size={I} />, onClick: () => ctx.run(t("체크아웃"), withStashOffer(ctx, short, () => api.checkoutDetached(ctx.path, c.hash)), { success: t("{short} 체크아웃", { short }) }) },
    { label: t("여기서 새 브랜치…"), icon: <GitBranchPlus size={I} />, onClick: () => createBranchFlow(ctx, c.hash, `${short} ${c.subject}`) },
    { label: t("여기서 워크트리…"), icon: <GitFork size={I} />, onClick: () => addWorktreeFlow(ctx, null, c.hash) },
    { label: t("태그 만들기…"), icon: <Tag size={I} />, onClick: () => createTagFlow(ctx, c.hash) },
    { separator: true },
    { label: t("'{cur}'에 체리픽", { cur }), icon: <Cherry size={I} />, onClick: () => ctx.runOp(t("체리픽"), () => api.cherryPick(ctx.path, c.hash), t("{short} 체리픽 완료", { short })) },
    { label: t("'{cur}'에 병합…", { cur }), icon: <GitMerge size={I} />, onClick: () => mergeFlow(ctx, c.hash, short) },
    { label: t("'{cur}'을(를) 여기로 리베이스…", { cur }), icon: <Workflow size={I} />, onClick: () => rebaseFlow(ctx, c.hash, short) },
    {
      label: t("여기부터 인터랙티브 리베이스…"),
      icon: <Workflow size={I} />,
      hint: "reword · squash · drop",
      onClick: () => ctx.startRebase({ hash: c.hash, label: `${short} ${c.subject}` }),
    },
    { label: t("되돌리기 커밋 (revert)"), icon: <Undo2 size={I} />, onClick: () => ctx.runOp("Revert", () => api.revert(ctx.path, c.hash), t("{short} 되돌리기 커밋을 만들었습니다", { short })) },
    {
      label: `'${cur}' reset`,
      icon: <RotateCcw size={I} />,
      submenu: [
        { label: t("Soft — 변경을 스테이징에 유지"), onClick: () => resetFlow(ctx, c.hash, "soft") },
        { label: t("Mixed — 변경을 작업 트리에 유지"), onClick: () => resetFlow(ctx, c.hash, "mixed") },
        { label: t("Hard — 모든 변경 버리기"), danger: true, onClick: () => resetFlow(ctx, c.hash, "hard") },
      ],
    },
    { separator: true },
    { label: t("SHA 복사"), icon: <Copy size={I} />, hint: short, onClick: () => copyText(c.hash) },
    { label: t("메시지 복사"), icon: <Copy size={I} />, onClick: () => copyText(c.subject) },
    {
      label: t("웹에서 보기"),
      icon: <ExternalLink size={I} />,
      disabled: !defaultRemote(ctx)?.repoUrl,
      onClick: () => openOnForge(ctx, (base, kind) => (kind === "gitlab" ? `${base}/-/commit/${c.hash}` : `${base}/commit/${c.hash}`)),
    },
  ];
}

export function isWip(hash: string | null) {
  return hash === WIP;
}

/** HTTPS remotes of a repository opened over SSH, which can switch to an SSH key. */
export function sshKeyCandidates(ctx: RepoCtx): ForgeRemote[] {
  if (!ctx.path.startsWith("ssh://")) return [];
  return ctx.forgeRemotes.filter((fr) => /^https?:\/\//.test(fr.url) && fr.target);
}

/**
 * One step from "the PC cannot sign in to GitHub" to working fetch/push: make a
 * key for this repository on that PC, add it as the repository's deploy key,
 * and point the remote at the SSH URL.
 */
export async function connectWithSshKey(ctx: RepoCtx, remote?: string) {
  const list = sshKeyCandidates(ctx);
  const fr = list.find((r) => r.remote === remote) ?? (list.length === 1 ? list[0] : undefined);
  const host = ctx.path.slice("ssh://".length).split("/")[0];
  const v = await ask({
    title: t("SSH 키로 연결"),
    message: tj("{host}에 이 저장소 전용 키를 만들어 배포 키로 등록하고, 원격 주소를 SSH로 바꿉니다. 키는 이 저장소에만 쓸 수 있습니다.", {
      host: <b>{host}</b>,
    }),
    fields: fr
      ? undefined
      : [{ name: "remote", label: t("원격"), type: "select", options: list.map((r) => ({ value: r.remote, label: `${r.remote} · ${r.url}` })), value: list[0]?.remote }],
    confirmLabel: t("연결"),
  });
  if (!v) return;
  const name = fr?.remote ?? String(v.remote ?? "");
  if (!name) return;
  const done = await ctx.run(t("SSH 키로 연결"), () => api.useSshKey(ctx.path, name), { success: (m) => m });
  if (done) await ctx.run("Fetch", () => api.fetch(ctx.path, name), { quiet: true });
}
