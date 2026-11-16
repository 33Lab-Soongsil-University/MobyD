// In-app updates. The app asks the public release feed whether a newer version
// exists, downloads the signed archive, swaps itself and restarts. Only the
// real app does this; the browser dev bridge has nothing to update.
import { create } from "zustand";
import type { Update } from "@tauri-apps/plugin-updater";
import { errorText } from "./api";

export type UpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "installed" | "error";

interface UpdateState {
  phase: UpdatePhase;
  /** Version on offer (available / downloading / installed). */
  version: string | null;
  notes: string | null;
  /** 0–1 while downloading; null when the size is unknown. */
  progress: number | null;
  error: string | null;
  checkedAt: number | null;
}

export const useUpdate = create<UpdateState>(() => ({ phase: "idle", version: null, notes: null, progress: null, error: null, checkedAt: null }));

const inApp = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && !(window as { __MOBYD_BRIDGE__?: boolean }).__MOBYD_BRIDGE__;

export const canUpdate = inApp;

let pending: Update | null = null;

/** Look for a newer release. `quiet` keeps a failed background check out of the way. */
export async function checkForUpdate(quiet = false): Promise<void> {
  if (!inApp()) return;
  const now = useUpdate.getState().phase;
  if (now === "checking" || now === "downloading" || now === "installed") return;
  if (!quiet) useUpdate.setState({ phase: "checking", error: null });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const found = await check();
    pending = found;
    useUpdate.setState(
      found
        ? { phase: "available", version: found.version, notes: found.body?.trim() || null, error: null, checkedAt: Date.now() }
        : { phase: "current", version: null, notes: null, error: null, checkedAt: Date.now() },
    );
  } catch (e) {
    // offline, or the feed is briefly unavailable: a background check just tries again later
    if (quiet) return;
    useUpdate.setState({ phase: "error", error: errorText(e), checkedAt: Date.now() });
  }
}

/** Download and install the update found by `checkForUpdate`, then restart. */
export async function installUpdate(): Promise<void> {
  if (!pending || useUpdate.getState().phase === "downloading") return;
  useUpdate.setState({ phase: "downloading", progress: null, error: null });
  try {
    let total = 0;
    let got = 0;
    await pending.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        useUpdate.setState({ progress: total ? Math.min(1, got / total) : null });
      }
    });
    useUpdate.setState({ phase: "installed", progress: 1 });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    useUpdate.setState({ phase: "error", error: errorText(e) });
  }
}

const FIRST_CHECK_MS = 8_000;
const RECHECK_MS = 6 * 60 * 60 * 1000;

/** Check shortly after launch and then a few times a day. */
export function startUpdateChecks(): () => void {
  if (!inApp() || import.meta.env.DEV) return () => {};
  const first = window.setTimeout(() => checkForUpdate(true), FIRST_CHECK_MS);
  const again = window.setInterval(() => checkForUpdate(true), RECHECK_MS);
  return () => {
    window.clearTimeout(first);
    window.clearInterval(again);
  };
}
