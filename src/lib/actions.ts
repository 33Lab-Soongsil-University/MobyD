import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, errorText } from "./api";
import { ask, toast, useUi } from "../store";
import { t } from "./i18n";

export async function openRepoPath(path: string) {
  try {
    const info = await api.openRepo(path);
    useUi.getState().addTab(info);
    return info;
  } catch (e) {
    toast.error(t("저장소를 열 수 없습니다"), errorText(e));
    return null;
  }
}

export async function pickDirectory(title: string, defaultPath?: string): Promise<string | null> {
  const r = await open({ directory: true, multiple: false, title, defaultPath });
  return typeof r === "string" ? r : null;
}

export async function openRepoDialog() {
  const dir = await pickDirectory(t("Git 저장소 열기"));
  if (dir) await openRepoPath(dir);
}

export async function initRepoDialog() {
  const dir = await pickDirectory(t("새 저장소를 만들 폴더 선택"));
  if (!dir) return;
  const ok = await ask({
    title: t("새 저장소 만들기"),
    message: t("{dir} 에서 git init -b main 을 실행합니다.", { dir }),
    confirmLabel: t("만들기"),
  });
  if (!ok) return;
  try {
    await api.initRepo(dir);
    toast.success(t("저장소를 만들었습니다"), dir);
    await openRepoPath(dir);
  } catch (e) {
    toast.error(t("저장소를 만들 수 없습니다"), errorText(e));
  }
}

export async function copyText(text: string, label = t("복사했습니다")) {
  try {
    await navigator.clipboard.writeText(text);
    toast.info(label, text.length > 80 ? text.slice(0, 80) + "…" : text);
  } catch (e) {
    toast.error(t("클립보드에 복사하지 못했습니다"), errorText(e));
  }
}

const CLONE_DIR_KEY = "mobyd.cloneParent";

export function getCloneDir(): string {
  try {
    return localStorage.getItem(CLONE_DIR_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setCloneDir(dir: string) {
  try {
    localStorage.setItem(CLONE_DIR_KEY, dir);
  } catch {
    /* ignore */
  }
}

export const isRemotePath = (p: string) => p.startsWith("ssh://");

/** Build the `ssh://host/path` identity used for remote repositories. */
export function sshUri(host: string, path: string) {
  return `ssh://${host}/${path.replace(/^\/+/, "")}`;
}

/** Reveal a local file in Finder/Explorer; remote paths have no local folder. */
export async function revealPath(path: string) {
  if (isRemotePath(path)) {
    toast.info(t("원격(SSH) 저장소는 이 컴퓨터의 Finder로 열 수 없습니다"), t("툴바의 터미널 버튼으로 원격 셸을 여세요."));
    return;
  }
  revealItemInDir(path).catch(() => {});
}
