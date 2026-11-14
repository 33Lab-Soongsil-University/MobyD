import { locale, t } from "./i18n";
let rtfCache: Intl.RelativeTimeFormat | null = null;
const rtf = () => (rtfCache ??= new Intl.RelativeTimeFormat(locale(), { numeric: "auto" }));

export function relativeTime(unixSeconds: number, now = Date.now() / 1000): string {
  const diff = unixSeconds - now;
  const abs = Math.abs(diff);
  if (abs < 45) return t("방금");
  if (abs < 3600) return rtf().format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf().format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf().format(Math.round(diff / 86400), "day");
  if (abs < 86400 * 365) return rtf().format(Math.round(diff / (86400 * 30)), "month");
  return rtf().format(Math.round(diff / (86400 * 365)), "year");
}

export function absoluteTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(locale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function isoRelative(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : relativeTime(t / 1000);
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The part of a name worth keeping visible when it has to be shortened: the
 *  last "-x"/"_x"/".x" segment (or the last few characters). Returns [head, tail];
 *  tail is empty for short names. */
export function splitTail(name: string, keep = 10): [string, string] {
  const chars = [...name];
  if (chars.length <= keep + 6) return [name, ""];
  const tailMin = Math.min(6, keep);
  let cut = chars.length - tailMin;
  for (let i = chars.length - tailMin; i >= chars.length - keep - 2 && i > 0; i--) {
    if ("-_. ".includes(chars[i])) {
      cut = i;
      break;
    }
  }
  return [chars.slice(0, cut).join(""), chars.slice(cut).join("")];
}

/** A path split so its end stays visible when shortened: [parents, "/dir/name"]. */
export function splitPathTail(path: string): [string, string] {
  const parts = path.split("/");
  if (parts.length <= 3 || path.length <= 40) return [path, ""];
  const tail = "/" + parts.slice(-2).join("/");
  return [path.slice(0, path.length - tail.length), tail];
}

/** A tab or repository name without the " @ host" suffix SSH repositories carry. */
export function repoBaseName(name: string, host?: string | null): string {
  if (host && name.endsWith(` @ ${host}`)) return name.slice(0, -(host.length + 3));
  return name;
}

/** "devbox:E:/repo" for ssh://devbox/E:/repo, the path itself otherwise. */
export function displayRoot(root: string): string {
  const m = /^ssh:\/\/([^/]+)\/(.*)$/.exec(root);
  if (!m) return root;
  const path = /^[A-Za-z]:/.test(m[2]) ? m[2] : "/" + m[2];
  return `${m[1]}:${path}`;
}

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i <= 0 ? "" : path.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  return dir.replace(/[\\/]+$/, "") + "/" + name;
}

export const STATUS_LABEL: Record<string, string> = {
  A: t("추가"),
  M: t("수정"),
  D: t("삭제"),
  R: t("이름 변경"),
  C: t("복사"),
  T: t("타입 변경"),
  U: t("충돌"),
  "?": t("새 파일"),
};
