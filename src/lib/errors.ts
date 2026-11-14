// Turn raw git / network / ssh output into a sentence a person can act on.
// The original text is kept for a "details" disclosure (see `rawFor`).
import { t } from "./i18n";

export interface Friendly {
  /** What happened and what to do, in the UI language. */
  message: string;
  /** Files the message is about (e.g. "would be overwritten"), at most a few. */
  files: string[];
  /** The original text, for the details view. */
  raw: string;
  /** True when a known pattern matched (otherwise the message is the cleaned first line). */
  known: boolean;
}

type Rule = { re: RegExp; msg: (m: RegExpMatchArray, raw: string) => string; files?: boolean };

const RULES: Rule[] = [
  {
    re: /detected dubious ownership in repository at '([^']+)'/,
    msg: () => t("이 폴더의 소유자가 지금 사용자와 달라서 git이 작업을 막았습니다. 터미널에서 git config --global --add safe.directory <폴더> 를 실행하면 허용됩니다."),
  },
  { re: /not a git repository/i, msg: () => t("Git 저장소가 아닌 폴더입니다. 저장소 폴더를 골라 주세요.") },
  {
    re: /Your local changes to the following files would be overwritten by (checkout|merge)/,
    msg: (m) =>
      m[1] === "checkout"
        ? t("커밋하지 않은 변경이 있어서 브랜치를 바꿀 수 없습니다. 변경을 커밋하거나 Stash한 뒤 다시 시도하세요.")
        : t("커밋하지 않은 변경이 있어서 병합할 수 없습니다. 변경을 커밋하거나 Stash한 뒤 다시 시도하세요."),
    files: true,
  },
  {
    re: /untracked working tree files would be (overwritten|removed)/,
    msg: () => t("추적하지 않는 파일이 덮어써질 수 있어서 멈췄습니다. 아래 파일을 옮기거나 지운 뒤 다시 시도하세요."),
    files: true,
  },
  {
    re: /cannot (pull with rebase|rebase): (You have unstaged changes|Your index contains uncommitted changes)/,
    msg: () => t("커밋하지 않은 변경이 있어서 리베이스할 수 없습니다. 변경을 커밋하거나 Stash한 뒤 다시 시도하세요."),
  },
  { re: /CONFLICT \(|Automatic merge failed|could not apply [0-9a-f]+/, msg: () => t("충돌이 생겼습니다. 오른쪽 패널에서 충돌 파일을 해결한 뒤 계속하거나 중단하세요.") },
  { re: /refusing to allow an OAuth App to create or update workflow/, msg: () => t("GitHub 워크플로 파일을 바꾸려면 workflow 권한이 필요합니다. 계정을 다시 연결해 권한을 받으세요.") },
  { re: /protected branch|GH006/i, msg: () => t("보호된 브랜치라서 서버가 push를 거부했습니다. 다른 브랜치로 push한 뒤 풀 리퀘스트를 만드세요.") },
  { re: /GH001: Large files|exceeds GitHub's file size limit/, msg: () => t("너무 큰 파일이 있어서 서버가 push를 거부했습니다. 큰 파일을 커밋에서 빼거나 Git LFS를 쓰세요.") },
  { re: /pre-receive hook declined/, msg: () => t("서버의 규칙 때문에 push가 거부됐습니다. 자세히 보기에서 서버가 보낸 이유를 확인하세요.") },
  { re: /stale info/, msg: () => t("마지막으로 확인한 뒤 원격 브랜치가 바뀌어서 강제 push를 멈췄습니다. Fetch로 받아 확인한 뒤 다시 시도하세요.") },
  {
    re: /\[rejected\].*\((fetch first|non-fast-forward)\)|Updates were rejected because/,
    msg: () => t("원격에 이 브랜치의 새 커밋이 있어서 push가 거부됐습니다. 먼저 Pull로 받아온 뒤 다시 push하세요."),
  },
  {
    re: /You have divergent branches|Need to specify how to reconcile divergent branches|Not possible to fast-forward/,
    msg: () => t("로컬과 원격에 서로 다른 커밋이 있어서 fast-forward로 받을 수 없습니다. Pull 메뉴에서 merge 또는 rebase를 고르세요."),
  },
  {
    re: /There is no tracking information for the current branch|has no upstream branch/,
    msg: () => t("이 브랜치에 연결된 원격 브랜치(업스트림)가 없습니다. 브랜치 메뉴의 '업스트림 설정'을 쓰거나 Push로 연결하세요."),
  },
  { re: /couldn't find remote ref ([^\s]+)/, msg: (m) => t("원격에 '{ref}'가 없습니다. 이미 지워졌거나 이름이 다를 수 있습니다.", { ref: m[1].replace(/^refs\/heads\//, "") }) },
  { re: /a branch named '([^']+)' already exists/, msg: (m) => t("'{name}' 브랜치가 이미 있습니다. 다른 이름을 쓰세요.", { name: m[1] }) },
  { re: /tag '([^']+)' already exists/, msg: (m) => t("'{name}' 태그가 이미 있습니다. 다른 이름을 쓰세요.", { name: m[1] }) },
  { re: /would clobber existing tag/, msg: () => t("원격의 태그가 로컬 태그와 달라서 가져오지 않았습니다. 같은 이름의 로컬 태그를 지운 뒤 다시 가져오세요.") },
  {
    re: /The branch '([^']+)' is not fully merged/,
    msg: (m) => t("'{name}' 브랜치에는 아직 병합되지 않은 커밋이 있어서 지우지 않았습니다. 그래도 지우려면 '병합되지 않았어도 강제로 삭제'를 고르세요.", { name: m[1] }),
  },
  {
    re: /Cannot delete branch '([^']+)' (checked out|used by worktree) at '([^']+)'/,
    msg: (m) => t("'{name}' 브랜치는 체크아웃되어 있어서 지울 수 없습니다({path}). 다른 브랜치로 바꾼 뒤 지우세요.", { name: m[1], path: m[3] }),
  },
  {
    re: /'([^']+)' is already (checked out|used by worktree) at '([^']+)'/,
    msg: (m) => t("'{name}' 브랜치는 다른 워크트리({path})에서 쓰고 있어서 여기서 체크아웃할 수 없습니다.", { name: m[1], path: m[3] }),
  },
  {
    re: /index\.lock'?: File exists|Another git process seems to be running/,
    msg: () => t("다른 git 작업이 진행 중이라 멈췄습니다. 잠시 뒤 다시 시도하세요. 계속되면 다른 git 프로그램이 이 저장소를 쓰고 있는지 확인하세요."),
  },
  { re: /Aborting commit due to empty commit message/, msg: () => t("커밋 메시지가 비어 있어서 커밋하지 않았습니다.") },
  { re: /The previous cherry-pick is now empty|is now empty, possibly due to conflict resolution/, msg: () => t("이 커밋의 변경이 이미 들어 있어서 체리픽할 내용이 없습니다.") },
  { re: /nothing to commit|no changes added to commit/, msg: () => t("커밋할 변경이 없습니다. 먼저 파일을 스테이징하세요.") },
  { re: /You are not currently on a branch/, msg: () => t("분리된 HEAD 상태라서 할 수 없습니다. 먼저 브랜치를 만들거나 체크아웃하세요.") },
  { re: /refusing to merge unrelated histories/, msg: () => t("두 브랜치에 공통된 이력이 없어서 병합하지 않았습니다.") },
  {
    re: /Please tell me who you are|unable to auto-detect email address/,
    msg: () => t("이 PC에 git 사용자 이름과 이메일이 설정되어 있지 않습니다. 터미널에서 git config --global user.name 과 user.email 을 설정하세요."),
  },
  { re: /Permission denied \(publickey/, msg: () => t("SSH 키 인증에 실패했습니다. ssh-agent에 키를 올리거나 ~/.ssh/config의 IdentityFile을 확인하세요.") },
  { re: /Host key verification failed/, msg: () => t("처음 접속하는 서버라 확인이 필요합니다. 터미널에서 한 번 ssh로 접속해 서버를 등록하세요.") },
  {
    re: /could not read Username|Authentication failed|terminal prompts disabled|Invalid username or (password|token)|HTTP Basic: Access denied/i,
    msg: () => t("원격 저장소에 로그인이 필요합니다. 환경설정 → 통합에서 계정을 연결하거나 SSH 주소를 쓰세요."),
  },
  {
    re: /Repository not found|repository '[^']*' not found|does not appear to be a git repository/,
    msg: () => t("원격 저장소를 찾을 수 없습니다. 주소가 맞는지, 이 계정에 접근 권한이 있는지 확인하세요."),
  },
  { re: /API rate limit exceeded/i, msg: () => t("서비스의 API 호출 한도를 넘었습니다. 잠시 뒤 다시 시도하세요.") },
  {
    re: /^SSH ([^:]+):.*(timed out|Connection refused|No route to host|Could not resolve|Network is unreachable)/s,
    msg: (m) => t("{host}에 연결하지 못했습니다. PC가 켜져 있는지, 네트워크·VPN(Tailscale) 연결과 SSH 설정의 주소를 확인하세요.", { host: m[1] }),
  },
  {
    re: /Could not resolve host|Couldn't resolve host|Failed to connect|Connection timed out|Operation timed out|Connection refused|Network is unreachable|No route to host|error sending request/i,
    msg: () => t("서버에 연결하지 못했습니다. 인터넷·VPN 연결을 확인한 뒤 다시 시도하세요."),
  },
  {
    re: /destination path '([^']+)' already exists and is not an empty directory/,
    msg: (m) => t("같은 이름의 폴더가 이미 있습니다({path}). 다른 폴더 이름이나 위치를 고르세요.", { path: m[1] }),
  },
  { re: /pathspec '([^']+)' did not match/, msg: (m) => t("'{path}'을(를) 찾을 수 없습니다.", { path: m[1] }) },
  { re: /unknown revision or path not in the working tree|bad revision|Needed a single revision/, msg: () => t("그 커밋이나 브랜치를 찾을 수 없습니다.") },
];

/** File names git lists after messages like "would be overwritten" (tab-indented lines). */
function listedFiles(raw: string): string[] {
  return raw
    .split("\n")
    .filter((l) => /^\t\S/.test(l))
    .map((l) => l.trim())
    .slice(0, 6);
}

/** The first meaningful line(s) without git's "fatal:" / "error:" / "hint:" noise. */
function clean(raw: string): string {
  const lines = raw
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/^git [\w-]+: /, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(hint:|To |remote: *$|Aborting$|\(use "git)/.test(l))
    .map((l) => l.replace(/^(fatal|error|warning): */i, ""));
  const text = lines.slice(0, 2).join(" ");
  if (!text) return t("알 수 없는 오류가 생겼습니다.");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function humanize(raw: string): Friendly {
  for (const r of RULES) {
    const m = raw.match(r.re);
    if (m) return { message: r.msg(m, raw), files: r.files ? listedFiles(raw) : [], raw, known: true };
  }
  // Our own messages (already sentences, possibly with a hint paragraph) pass through.
  const ownSentence = !/(^|\n)(fatal|error|hint):|^git [\w-]+: /.test(raw) && raw.length < 400;
  return { message: ownSentence ? raw.trim() : clean(raw), files: [], raw, known: false };
}

// Map from shown text to the original, so a toast or error box can offer "details".
const RAW = new Map<string, string>();

/** Friendly text for an error; remembers the original for `rawFor`. */
export function friendlyText(raw: string): string {
  const f = humanize(raw);
  const text = f.files.length ? `${f.message}\n${f.files.map((x) => `• ${x}`).join("\n")}` : f.message;
  if (text.trim() !== raw.trim()) {
    RAW.set(text, raw);
    if (RAW.size > 200) RAW.delete(RAW.keys().next().value as string);
  }
  return text;
}

/** The original error text behind a friendly message, if it differs. */
export function rawFor(text: string | undefined | null): string | null {
  return text ? (RAW.get(text) ?? null) : null;
}
