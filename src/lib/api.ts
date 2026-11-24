import { invoke } from "@tauri-apps/api/core";
import { friendlyText } from "./errors";
import type {
  Account,
  DeviceStart,
  DevicePoll,
  AppInfo,
  CommitDetail,
  Commit,
  DiffRequest,
  DirListing,
  HostPrefs,
  SshHost,
  TailscalePeer,
  Blame,
  ForgeRepo,
  RebasePlan,
  RebaseStep,
  ForgeKind,
  ForgeRemote,
  GraphPayload,
  MergeOptions,
  NewPullRequest,
  OpOutcome,
  PrComment,
  PullRequest,
  Remote,
  RepoInfo,
  Settings,
  Status,
  Worktree,
  WorktreeAddRequest,
} from "./types";

/** Typed wrappers around the Rust commands registered in `src-tauri/src/lib.rs`. */
export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  settings: () => invoke<Settings>("settings_get"),
  saveTabs: (tabs: string[], active: string | null) => invoke<void>("settings_save_tabs", { tabs, active }),
  savePrefs: (prefs: Record<string, unknown>) => invoke<void>("settings_save_prefs", { prefs }),
  removeRecent: (path: string) => invoke<Settings>("recent_remove", { path }),

  openRepo: (path: string) => invoke<RepoInfo>("repo_open", { path }),
  initRepo: (path: string) => invoke<string>("repo_init", { path }),
  cloneRepo: (url: string, dest: string) => invoke<string>("repo_clone", { url, dest }),
  fingerprint: (repo: string) => invoke<string>("repo_fingerprint", { repo }),
  graph: (repo: string, limit: number, showStashes = true) =>
    invoke<GraphPayload>("repo_graph", { repo, limit, showStashes }),
  status: (repo: string) => invoke<Status>("repo_status", { repo }),
  commitDetail: (repo: string, sha: string) => invoke<CommitDetail>("commit_detail", { repo, sha }),
  diff: (repo: string, request: DiffRequest) => invoke<string>("file_diff", { repo, request }),
  fileHistory: (repo: string, path: string, limit = 200) => invoke<Commit[]>("file_history", { repo, path, limit }),

  stage: (repo: string, paths: string[]) => invoke<void>("stage_paths", { repo, paths }),
  unstage: (repo: string, paths: string[]) => invoke<void>("unstage_paths", { repo, paths }),
  discard: (repo: string, tracked: string[], untracked: string[]) =>
    invoke<void>("discard_paths", { repo, tracked, untracked }),
  applyPatch: (repo: string, patch: string, cached: boolean, reverse: boolean) =>
    invoke<void>("apply_patch", { repo, patch, cached, reverse }),
  commit: (repo: string, message: string, amend: boolean) => invoke<string>("commit_create", { repo, message, amend }),
  lastMessage: (repo: string) => invoke<string>("commit_last_message", { repo }),

  checkout: (repo: string, name: string, remote = false, localName: string | null = null) =>
    invoke<string>("branch_checkout", { repo, name, remote, localName }),
  checkoutDetached: (repo: string, rev: string) => invoke<string>("checkout_detached", { repo, rev }),
  createBranch: (repo: string, name: string, start: string | null, checkout: boolean) =>
    invoke<string>("branch_create", { repo, name, start, checkout }),
  deleteBranch: (repo: string, name: string, force: boolean) => invoke<string>("branch_delete", { repo, name, force }),
  deleteRemoteBranch: (repo: string, remote: string, branch: string) =>
    invoke<string>("branch_delete_remote", { repo, remote, branch }),
  renameBranch: (repo: string, oldName: string, newName: string) =>
    invoke<string>("branch_rename", { repo, old: oldName, new: newName }),
  setUpstream: (repo: string, branch: string, upstream: string) =>
    invoke<string>("branch_set_upstream", { repo, branch, upstream }),
  fastForward: (repo: string, branch: string, upstream: string) =>
    invoke<string>("branch_fast_forward", { repo, branch, upstream }),
  openTerminal: (path: string) => invoke<void>("open_terminal", { path }),
  undo: (repo: string) => invoke<string>("undo", { repo }),
  redo: (repo: string) => invoke<string>("redo", { repo }),
  rebasePlan: (repo: string, base: string) => invoke<RebasePlan>("rebase_plan", { repo, base }),
  rebaseInteractive: (repo: string, base: string, steps: RebaseStep[]) =>
    invoke<OpOutcome>("rebase_interactive", { repo, base, steps }),
  blame: (repo: string, path: string, rev: string | null = null) => invoke<Blame>("file_blame", { repo, path, rev }),
  accountRepos: (id: string) => invoke<ForgeRepo[]>("account_repos", { id }),
  findLocalClones: (urls: string[]) => invoke<Record<string, string>>("find_local_clones", { urls }),
  sshHosts: () => invoke<SshHost[]>("ssh_hosts"),
  sshListDir: (host: string, path: string | null) => invoke<DirListing>("ssh_list_dir", { host, path }),
  sshHostPrefs: () => invoke<Record<string, HostPrefs>>("ssh_host_prefs"),
  sshSetHostPrefs: (host: string, prefs: HostPrefs) => invoke<Record<string, HostPrefs>>("ssh_set_host_prefs", { host, prefs }),
  sshTailscalePeers: () => invoke<TailscalePeer[]>("ssh_tailscale_peers"),
  merge: (repo: string, rev: string, mode: string, message: string | null = null) =>
    invoke<OpOutcome>("merge_ref", { repo, rev, mode, message }),
  rebase: (repo: string, onto: string) => invoke<OpOutcome>("rebase_onto", { repo, onto }),
  cherryPick: (repo: string, sha: string) => invoke<OpOutcome>("cherry_pick", { repo, sha }),
  revert: (repo: string, sha: string) => invoke<OpOutcome>("revert_commit", { repo, sha }),
  reset: (repo: string, sha: string, mode: "soft" | "mixed" | "hard") => invoke<string>("reset_to", { repo, sha, mode }),
  sequencer: (repo: string, operation: string, action: "continue" | "abort" | "skip") =>
    invoke<OpOutcome>("sequencer", { repo, operation, action }),
  resolveConflict: (repo: string, path: string, side: "ours" | "theirs") =>
    invoke<void>("conflict_resolve", { repo, path, side }),
  createTag: (repo: string, name: string, rev: string, message: string | null) =>
    invoke<string>("tag_create", { repo, name, rev, message }),
  deleteTag: (repo: string, name: string) => invoke<string>("tag_delete", { repo, name }),
  pushTag: (repo: string, remote: string, name: string) => invoke<string>("tag_push", { repo, remote, name }),

  fetch: (repo: string, remote: string | null = null) => invoke<string>("remote_fetch", { repo, remote }),
  pull: (repo: string, mode: "ff-only" | "merge" | "rebase") => invoke<OpOutcome>("remote_pull", { repo, mode }),
  push: (repo: string, opts: { remote?: string | null; branch?: string | null; setUpstream?: boolean; force?: boolean }) =>
    invoke<string>("remote_push", {
      repo,
      remote: opts.remote ?? null,
      branch: opts.branch ?? null,
      setUpstream: opts.setUpstream ?? false,
      force: opts.force ?? false,
    }),
  remotes: (repo: string) => invoke<Remote[]>("remote_list", { repo }),
  addRemote: (repo: string, name: string, url: string) => invoke<string>("remote_add", { repo, name, url }),
  removeRemote: (repo: string, name: string) => invoke<string>("remote_remove", { repo, name }),
  useSshKey: (repo: string, remote: string) => invoke<string>("remote_use_ssh_key", { repo, remote }),

  stashSave: (repo: string, message: string | null, includeUntracked: boolean, stagedOnly = false) =>
    invoke<string>("stash_save", { repo, message, includeUntracked, stagedOnly }),
  stashAction: (repo: string, action: "apply" | "pop" | "drop", index: number) =>
    invoke<OpOutcome>("stash_action", { repo, action, index }),

  worktrees: (repo: string) => invoke<Worktree[]>("worktree_list", { repo }),
  addWorktree: (repo: string, request: WorktreeAddRequest) => invoke<string>("worktree_add", { repo, request }),
  removeWorktree: (repo: string, path: string, force: boolean) => invoke<string>("worktree_remove", { repo, path, force }),
  lockWorktree: (repo: string, path: string, lock: boolean, reason: string | null = null) =>
    invoke<string>("worktree_lock", { repo, path, lock, reason }),
  pruneWorktrees: (repo: string) => invoke<string>("worktree_prune", { repo }),

  forgeRemotes: (repo: string) => invoke<ForgeRemote[]>("forge_remotes", { repo }),
  prList: (repo: string, remote: string, prState: string) => invoke<PullRequest[]>("pr_list", { repo, remote, prState }),
  prGet: (repo: string, remote: string, number: number) => invoke<PullRequest>("pr_get", { repo, remote, number }),
  prCreate: (repo: string, remote: string, request: NewPullRequest) =>
    invoke<PullRequest>("pr_create", { repo, remote, request }),
  prMerge: (repo: string, remote: string, number: number, options: MergeOptions) =>
    invoke<string>("pr_merge", { repo, remote, number, options }),
  prClose: (repo: string, remote: string, number: number) => invoke<void>("pr_close", { repo, remote, number }),
  prComments: (repo: string, remote: string, number: number) =>
    invoke<PrComment[]>("pr_comments", { repo, remote, number }),
  prAddComment: (repo: string, remote: string, number: number, body: string) =>
    invoke<PrComment>("pr_add_comment", { repo, remote, number, body }),
  prCheckout: (repo: string, remote: string, number: number) => invoke<string>("pr_checkout", { repo, remote, number }),

  accounts: () => invoke<Account[]>("accounts_list"),
  addAccount: (kind: ForgeKind, baseUrl: string, token: string, apiUrl: string | null) =>
    invoke<Account[]>("account_add", { kind, baseUrl, token, apiUrl }),
  removeAccount: (id: string) => invoke<Account[]>("account_remove", { id }),
  importGh: (host: string | null = null) => invoke<Account[]>("account_import_gh", { host }),
  ghCliAvailable: () => invoke<boolean>("gh_cli_available"),
  oauthAvailable: (kind: ForgeKind, baseUrl: string) => invoke<boolean>("oauth_available", { kind, baseUrl }),
  oauthDeviceStart: (kind: ForgeKind, baseUrl: string) => invoke<DeviceStart>("oauth_device_start", { kind, baseUrl }),
  oauthDevicePoll: (flowId: string) => invoke<DevicePoll>("oauth_device_poll", { flowId }),
  oauthDeviceCancel: (flowId: string) => invoke<void>("oauth_device_cancel", { flowId }),
  setLocale: (lang: string) => invoke<void>("set_locale", { lang }),
};

/** The error as a sentence a person can act on (the original stays available via `rawFor`). */
export function errorText(e: unknown): string {
  return friendlyText(rawErrorText(e));
}

/** The error exactly as the backend or git produced it. */
export function rawErrorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
