// mobyd:// links from web pages and other apps.
//   mobyd://open?path=<repository>      open a local or ssh://host/path repository
//   mobyd://clone?url=<remote>          open the Clone screen with the URL filled in
//   mobyd://                            just bring MobyD forward
// Links never run anything beyond opening a repository or a screen: a web page
// can trigger them, so SSH hosts ask first and cloning waits for the user.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openRepoPath } from "./actions";
import { t } from "./i18n";
import { confirmAction, openManager, toast, useUi } from "../store";

export type Link = { kind: "open"; path: string } | { kind: "clone"; url: string } | { kind: "launch" };

export function parseLink(raw: string): Link | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol.toLowerCase() !== "mobyd:") return null;
  // mobyd://open?path=…  → host "open"; mobyd:open?path=… → pathname "open"
  const action = (u.hostname || u.pathname.replace(/^\/+/, "").split("/")[0] || "").toLowerCase();
  if (action === "") return { kind: "launch" };
  if (action === "open") {
    const path = (u.searchParams.get("path") ?? "").trim();
    const ok = path.startsWith("/") || path.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(path) || /^ssh:\/\/[^/\s]+\/./.test(path);
    return ok ? { kind: "open", path } : null;
  }
  if (action === "clone") {
    const url = (u.searchParams.get("url") ?? "").trim();
    const ok = /^(https?:\/\/|ssh:\/\/|git@)[^\s]+$/.test(url) && !url.startsWith("-");
    return ok ? { kind: "clone", url } : null;
  }
  return null;
}

/** A link that opens this repository in MobyD (for bookmarks, docs, chat). */
export function repoLink(root: string): string {
  return `mobyd://open?path=${encodeURIComponent(root)}`;
}

export function cloneLink(url: string): string {
  return `mobyd://clone?url=${encodeURIComponent(url)}`;
}

export async function handleLink(raw: string) {
  const link = parseLink(raw);
  if (!link) {
    toast.warning(t("알 수 없는 MobyD 링크입니다"), raw.slice(0, 200));
    return;
  }
  if (link.kind === "launch") return;
  if (link.kind === "clone") {
    useUi.setState({ cloneUrl: link.url });
    openManager("clone", "url");
    return;
  }
  const already = useUi.getState().tabs.find((tab) => tab.root === link.path);
  if (already) {
    useUi.getState().setActive(already.root);
    return;
  }
  if (link.path.startsWith("ssh://")) {
    const host = link.path.slice(6).split("/")[0];
    const ok = await confirmAction(
      t("링크로 원격 저장소 열기"),
      t("링크가 {host}의 저장소를 열려고 합니다: {path}. SSH로 접속해 열까요?", { host, path: link.path }),
      t("열기"),
    );
    if (!ok) return;
  }
  await openRepoPath(link.path);
}

async function drain() {
  const links = await invoke<string[]>("take_pending_links").catch(() => [] as string[]);
  for (const l of links) await handleLink(l);
}

/** Handle links that launched the app, then any that arrive while it runs. */
export async function startLinkHandling() {
  // listen first so a link arriving during the initial drain is not missed
  await listen("mobyd-link", () => {
    drain();
  }).catch(() => {});
  await drain();
}
