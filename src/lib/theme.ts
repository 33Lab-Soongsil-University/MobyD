import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemePref = "system" | "dark" | "light";
const KEY = "mobyd.theme";

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" ? v : "system";
  } catch {
    return "system";
  }
}

/** Apply a theme: "system" follows the OS (prefers-color-scheme) live. */
export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* ignore */
  }
  // Keep the native title bar / traffic lights in step (no-op outside Tauri).
  if ("__TAURI_INTERNALS__" in window && !(window as { __MOBYD_BRIDGE__?: boolean }).__MOBYD_BRIDGE__) {
    getCurrentWindow()
      .setTheme(pref === "system" ? null : pref)
      .catch(() => {});
  }
  window.dispatchEvent(new CustomEvent("mobyd-theme", { detail: pref }));
}

export function resolvedTheme(pref: ThemePref = getThemePref()): "dark" | "light" {
  if (pref !== "system") return pref;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
