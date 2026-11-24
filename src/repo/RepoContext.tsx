import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorText, rawErrorText } from "../lib/api";
import { isAuthFailure } from "../lib/errors";
import { refsByCommit } from "../lib/graph";
import type { DiffKind, ForgeRemote, GraphPayload, OpOutcome, RefInfo, RepoInfo, Worktree } from "../lib/types";
import { toast, useUi } from "../store";
import { t } from "../lib/i18n";

export const WIP = "WORKING_TREE";

export interface DiffTarget {
  kind: DiffKind;
  path: string;
  origPath?: string | null;
  sha?: string | null;
  /** Context label shown in the header, e.g. a commit subject. */
  label?: string;
}

export interface PrRef {
  remote: string;
  number: number;
}

export interface RepoCtx {
  path: string;
  info: RepoInfo;
  data: GraphPayload | null;
  error: string | null;
  loading: boolean;
  busy: string | null;
  worktrees: Worktree[];
  forgeRemotes: ForgeRemote[];
  refIndex: Map<string, RefInfo[]>;
  rowIndex: Map<string, number>;
  selected: string | null;
  select: (hash: string | null) => void;
  diff: DiffTarget | null;
  openDiff: (d: DiffTarget | null) => void;
  pr: PrRef | null;
  selectPr: (p: PrRef | null) => void;
  prVersion: number;
  bumpPrs: () => void;
  filter: string;
  setFilter: (q: string) => void;
  limit: number;
  loadMore: () => void;
  reload: () => Promise<void>;
  run: <T>(label: string, fn: () => Promise<T>, opts?: RunOpts<T>) => Promise<T | undefined>;
  runOp: (label: string, fn: () => Promise<OpOutcome>, success?: string) => Promise<OpOutcome | undefined>;
  jumpTo: (hash: string) => void;
  scrollTarget: { hash: string; n: number } | null;
  historyPath: string | null;
  showHistory: (path: string | null) => void;
  rebaseBase: { hash: string; label: string } | null;
  startRebase: (base: { hash: string; label: string } | null) => void;
  blame: { path: string; rev?: string | null } | null;
  openBlame: (b: { path: string; rev?: string | null } | null) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  isRemote: boolean;
}

interface RunOpts<T> {
  success?: string | ((r: T) => string | undefined);
  reload?: boolean;
  quiet?: boolean;
}

/** Thrown inside `run` when the user cancels a question; ends the action without an error toast. */
export const CANCELLED = Symbol("cancelled");

const Ctx = createContext<RepoCtx | null>(null);

export function useRepo(): RepoCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useRepo outside RepoProvider");
  return c;
}

const POLL_MS = 3500;
const POLL_REMOTE_MS = 5000;

export function RepoProvider({ info, active, children }: { info: RepoInfo; active: boolean; children: ReactNode }) {
  const path = info.root;
  const [data, setData] = useState<GraphPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [forgeRemotes, setForgeRemotes] = useState<ForgeRemote[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffTarget | null>(null);
  const [pr, setPr] = useState<PrRef | null>(null);
  const [prVersion, setPrVersion] = useState(0);
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(2000);
  const [scrollTarget, setScrollTarget] = useState<{ hash: string; n: number } | null>(null);
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  const [rebaseBase, setRebaseBase] = useState<{ hash: string; label: string } | null>(null);
  const [blame, setBlame] = useState<{ path: string; rev?: string | null } | null>(null);
  const fingerprint = useRef<string>("");
  const ctxRef = useRef<RepoCtx | null>(null);
  const loadSeq = useRef(0);
  const busyRef = useRef(false);

  const reload = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      // One call: graph, refs, status, worktrees, remotes and the change fingerprint
      // (a single SSH round trip for remote repositories).
      const g = await api.graph(path, limit);
      if (seq !== loadSeq.current) return;
      fingerprint.current = g.fingerprint;
      setData(g);
      setWorktrees(g.worktrees);
      setForgeRemotes(g.forgeRemotes);
      setError(null);
    } catch (e) {
      if (seq === loadSeq.current) setError(errorText(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [path, limit]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  // Pick up changes made outside MobyD (terminal, editor, other worktrees).
  useEffect(() => {
    if (!active) return;
    let stop = false;
    let inFlight = false;
    const check = async () => {
      // One check at a time: a slow or dropped SSH link must not pile up requests.
      if (stop || inFlight || busyRef.current || document.hidden) return;
      inFlight = true;
      try {
        const fp = await api.fingerprint(path);
        if (fp && fingerprint.current && fp !== fingerprint.current) await reload();
      } catch {
        /* repository might be mid-operation or the host briefly unreachable; try again next tick */
      } finally {
        inFlight = false;
      }
    };
    const id = window.setInterval(check, info.host ? POLL_REMOTE_MS : POLL_MS);
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    check();
    return () => {
      stop = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [path, reload, active, info.host]);

  // Default selection: the WIP row when dirty, otherwise HEAD.
  useEffect(() => {
    if (!data) return;
    if (selected && (selected === WIP || data.commits.some((c) => c.hash === selected))) return;
    if (selected === WIP && !data.commits.some((c) => c.hash === WIP)) {
      setSelected(data.head.commit);
      return;
    }
    if (!selected) setSelected(data.commits[0]?.hash ?? null);
  }, [data, selected]);

  // A working-tree diff follows its file: staging the file you are looking at
  // shows its staged diff, unstaging shows the unstaged one, and when the file
  // has no changes left (committed, discarded) the diff closes.
  useEffect(() => {
    const st = data?.status;
    if (!st || !diff || diff.kind === "commit") return;
    const inStaged = st.staged.some((f) => f.path === diff.path);
    const un = [...st.unstaged, ...st.conflicted].find((f) => f.path === diff.path);
    const here = diff.kind === "staged" ? inStaged : Boolean(un);
    if (here) return;
    if (diff.kind === "staged" && un) setDiff({ kind: un.status === "?" ? "untracked" : "unstaged", path: diff.path });
    else if (diff.kind !== "staged" && inStaged) setDiff({ kind: "staged", path: diff.path });
    else setDiff(null);
  }, [data, diff]);

  /** Error toast; when a repository opened over SSH cannot sign in to its HTTPS remote, offer the SSH key fix. */
  const failed = useCallback(
    (label: string, raw: string, detail: string) => {
      const canUseKey = path.startsWith("ssh://") && isAuthFailure(raw);
      useUi.getState().pushToast({
        kind: "error",
        title: t("{label} 실패", { label }),
        detail,
        ...(canUseKey && {
          sticky: true,
          action: { label: t("SSH 키로 연결"), run: () => void import("./actions").then((m) => ctxRef.current && m.connectWithSshKey(ctxRef.current)) },
        }),
      });
    },
    [path],
  );

  const run = useCallback(
    async <T,>(label: string, fn: () => Promise<T>, opts: RunOpts<T> = {}) => {
      setBusy(label);
      busyRef.current = true;
      try {
        const r = await fn();
        const msg = typeof opts.success === "function" ? opts.success(r) : opts.success;
        if (msg && !opts.quiet) toast.success(msg);
        return r;
      } catch (e) {
        // the user backed out of a question asked along the way: not a failure
        if (e !== CANCELLED) failed(label, rawErrorText(e), errorText(e));
        return undefined;
      } finally {
        busyRef.current = false;
        setBusy(null);
        if (opts.reload !== false) await reload();
      }
    },
    [reload, failed],
  );

  const runOp = useCallback(
    async (label: string, fn: () => Promise<OpOutcome>, success?: string) => {
      const r = await run(label, fn);
      if (!r) return r;
      if (r.ok) toast.success(success ?? t("{label} 완료", { label }), r.message || undefined);
      else if (r.conflicts) {
        toast.warning(t("{label} 중 충돌이 발생했습니다", { label }), t("오른쪽 패널에서 충돌을 해결한 뒤 계속하거나 중단하세요."));
        setSelected(WIP);
      } else failed(label, r.message, r.message);
      return r;
    },
    [run, failed],
  );

  const refIndex = useMemo(() => refsByCommit(data?.refs ?? []), [data]);
  const rowIndex = useMemo(() => {
    const m = new Map<string, number>();
    data?.commits.forEach((c, i) => m.set(c.hash, i));
    return m;
  }, [data]);

  const jumpTo = useCallback((hash: string) => {
    setSelected(hash);
    setScrollTarget((prev) => ({ hash, n: (prev?.n ?? 0) + 1 }));
  }, []);

  const value: RepoCtx = {
    path,
    info,
    data,
    error,
    loading,
    busy,
    worktrees,
    forgeRemotes,
    refIndex,
    rowIndex,
    selected,
    select: (h) => {
      setSelected(h);
      setPr(null);
    },
    diff,
    openDiff: (d) => {
      setDiff(d);
      if (d) setBlame(null);
    },
    pr,
    selectPr: setPr,
    prVersion,
    bumpPrs: () => setPrVersion((v) => v + 1),
    filter,
    setFilter,
    limit,
    loadMore: () => setLimit((l) => l + 2000),
    reload,
    run,
    runOp,
    jumpTo,
    scrollTarget,
    historyPath,
    showHistory: setHistoryPath,
    rebaseBase,
    startRebase: setRebaseBase,
    blame,
    openBlame: (b) => {
      setBlame(b);
      if (b) setDiff(null);
    },
    undo: async () => {
      const label = data?.undo.undo;
      if (!label) return;
      await run(t("실행 취소"), () => api.undo(path), { success: (l) => t("실행 취소: {l}", { l }) });
    },
    redo: async () => {
      const label = data?.undo.redo;
      if (!label) return;
      await run(t("다시 실행"), () => api.redo(path), { success: (l) => t("다시 실행: {l}", { l }) });
    },
    isRemote: path.startsWith("ssh://"),
  };

  ctxRef.current = value;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
