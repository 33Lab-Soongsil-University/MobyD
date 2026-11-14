// UI zoom (⌘+ / ⌘− / ⌘0). Uses the webview's own zoom in the app, so every
// measurement (virtual scrolling, menus) stays in CSS pixels; falls back to CSS
// `zoom` in a plain browser (dev bridge). The level survives restarts.
import { getCurrentWebview } from "@tauri-apps/api/webview";

const KEY = "mobyd.zoom";
export const ZOOM_STEPS = [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.5, 1.75, 2];

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function getZoom(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    if (v >= ZOOM_STEPS[0] && v <= ZOOM_STEPS[ZOOM_STEPS.length - 1]) return v;
  } catch {
    /* storage unavailable */
  }
  return 1;
}

async function apply(z: number) {
  try {
    if (inTauri()) {
      await getCurrentWebview().setZoom(z);
      document.documentElement.style.removeProperty("zoom");
      return;
    }
  } catch {
    /* not a real Tauri webview (dev bridge) or zoom unavailable: use CSS zoom */
  }
  document.documentElement.style.setProperty("zoom", String(z));
}

export async function setZoom(z: number) {
  const clamped = Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], Math.round(z * 100) / 100));
  try {
    localStorage.setItem(KEY, String(clamped));
  } catch {
    /* ignore */
  }
  await apply(clamped);
  window.dispatchEvent(new CustomEvent("mobyd-zoom", { detail: clamped }));
}

export function zoomIn() {
  const z = getZoom();
  return setZoom(ZOOM_STEPS.find((s) => s > z + 0.001) ?? z);
}

export function zoomOut() {
  const z = getZoom();
  return setZoom([...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? z);
}

export function resetZoom() {
  return setZoom(1);
}

/** Apply the saved level at start-up (no indicator). */
export function applySavedZoom() {
  const z = getZoom();
  if (z !== 1) apply(z).catch(() => {});
}

/** ⌘= / ⌘+ zoom in, ⌘− zoom out, ⌘0 reset. Returns true when the key was handled. */
export function handleZoomKey(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
  if (e.key === "=" || e.key === "+") zoomIn();
  else if (e.key === "-" || e.key === "_") zoomOut();
  else if (e.key === "0") resetZoom();
  else return false;
  e.preventDefault();
  return true;
}
