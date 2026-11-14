// Shapes returned by the Rust backend (serde camelCase).

export interface Commit {
  hash: string;
  short: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  commitTime: number;
  subject: string;
  kind?: "wip" | "stash";
}

export type SegmentKind = "pass" | "enter" | "leave";

export interface Segment {
  kind: SegmentKind;
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  lane: number;
  color: number;
  segments: Segment[];
}

export interface RefInfo {
  name: string;
  short: string;
  kind: "local" | "remote" | "tag";
  target: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  upstreamGone: boolean;
  isHead: boolean;
  remote: string | null;
  date: number;
  subject: string;
}

export interface HeadInfo {
  branch: string | null;
  commit: string | null;
  detached: boolean;
  unborn: boolean;
}

export interface FileEntry {
  path: string;
  origPath: string | null;
  status: string;
}

export interface Status {
  branch: string | null;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: FileEntry[];
  unstaged: FileEntry[];
  conflicted: FileEntry[];
}

export interface Stash {
  index: number;
  name: string;
  hash: string;
  message: string;
  time: number;
  base: string | null;
}

export interface RepoState {
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
  headName: string | null;
  onto: string | null;
  step: number | null;
  total: number | null;
  message: string | null;
}

export interface GraphPayload {
  commits: Commit[];
  rows: GraphRow[];
  maxLanes: number;
  refs: RefInfo[];
  head: HeadInfo;
  status: Status;
  stashes: Stash[];
  state: RepoState;
  hasMore: boolean;
  worktrees: Worktree[];
  forgeRemotes: ForgeRemote[];
  fingerprint: string;
  undo: UndoState;
}

export interface UndoState {
  undo: string | null;
  redo: string | null;
}

export interface RebasePlan {
  commits: Commit[];
  hasMerges: boolean;
  branch: string | null;
}

export type RebaseAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";

export interface RebaseStep {
  action: RebaseAction;
  hash: string;
  message?: string | null;
}

export interface BlameCommit {
  hash: string;
  author: string;
  authorTime: number;
  summary: string;
  uncommitted: boolean;
}

export interface Blame {
  path: string;
  lines: { line: number; hash: string; text: string }[];
  commits: Record<string, BlameCommit>;
}

export interface ForgeRepo {
  fullName: string;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  defaultBranch: string | null;
  cloneHttps: string;
  cloneSsh: string;
  webUrl: string;
  updatedAt: string;
}

export interface RepoInfo {
  /** Local path or `ssh://host/path`. */
  root: string;
  name: string;
  gitDir: string;
  commonDir: string;
  isWorktree: boolean;
  host: string | null;
  path: string;
}

export interface SshHost {
  alias: string;
  hostname: string | null;
  user: string | null;
  port: string | null;
  otherAliases: string[];
}

export interface DirListing {
  host: string;
  path: string;
  parent: string | null;
  entries: { name: string; isRepo: boolean }[];
  isRepo: boolean;
  gitVersion: string | null;
  os: string;
  /** How MobyD runs commands on the host, e.g. "Windows cmd → C:\\…\\bash.exe". */
  shell: string;
}

/** MobyD-only per-host SSH settings (the ssh config itself is never edited). */
export type ShellPref = "auto" | "posix" | "cmd" | "powershell";
export interface HostPrefs {
  shell: ShellPref;
  /** Overrides the config's HostName for MobyD only (e.g. a Tailscale address). */
  address: string | null;
}

export interface TailscalePeer {
  name: string;
  address: string;
  dns: string | null;
  os: string;
  online: boolean;
}

export interface ChangedFile {
  path: string;
  origPath: string | null;
  status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface CommitDetail {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  commitTime: number;
  subject: string;
  body: string;
  files: ChangedFile[];
}

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  isMain: boolean;
  isCurrent: boolean;
  openPath: string;
}

export interface Remote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface OpOutcome {
  ok: boolean;
  conflicts: boolean;
  message: string;
}

export type ForgeKind = "github" | "gitlab" | "gitea";

export interface RemoteTarget {
  host: string;
  webBase: string;
  path: string;
  owner: string;
  name: string;
}

export interface ForgeRemote {
  remote: string;
  url: string;
  target: RemoteTarget | null;
  kind: ForgeKind | null;
  accountId: string | null;
  accountUser: string | null;
  guessed: boolean;
  repoUrl: string | null;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string;
  authorAvatar: string | null;
  sourceBranch: string;
  targetBranch: string;
  sourceRepo: string | null;
  isFork: boolean;
  headSha: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  comments: number | null;
  mergeable: boolean | null;
  mergeStatus: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  commits: number | null;
}

export interface PrComment {
  id: string;
  author: string;
  authorAvatar: string | null;
  body: string;
  createdAt: string;
}

export interface Account {
  id: string;
  kind: ForgeKind;
  baseUrl: string;
  username: string | null;
  avatarUrl: string | null;
  apiUrl: string | null;
  hasToken: boolean;
  label: string;
}

export interface RecentRepo {
  path: string;
  name: string;
  lastOpened: number;
}

export interface Settings {
  recent: RecentRepo[];
  accounts: Omit<Account, "hasToken" | "label">[];
  openTabs: string[];
  activeTab: string | null;
  prefs: Record<string, unknown> | null;
}

export interface AppInfo {
  gitVersion: string | null;
  gitPath: string;
  version: string;
  platform: string;
}

export type DiffKind = "commit" | "staged" | "unstaged" | "untracked";

export interface DiffRequest {
  kind: DiffKind;
  path: string;
  origPath?: string | null;
  sha?: string | null;
  context?: number;
  ignoreWhitespace?: boolean;
}

export interface WorktreeAddRequest {
  path: string;
  branch?: string | null;
  newBranch?: boolean;
  start?: string | null;
  detach?: boolean;
}

export interface NewPullRequest {
  title: string;
  body: string;
  sourceBranch: string;
  targetBranch: string;
  draft: boolean;
}

export interface MergeOptions {
  method: "merge" | "squash" | "rebase";
  commitTitle?: string | null;
  commitMessage?: string | null;
  deleteBranch: boolean;
  expectedHeadSha?: string | null;
}

/** Browser sign-in (OAuth device flow): the code to show and the page to open. */
export interface DeviceStart {
  flowId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
  interval: number;
}

export interface DevicePoll {
  status: "pending" | "done" | "denied" | "expired";
  interval: number;
  accounts: Account[] | null;
}
