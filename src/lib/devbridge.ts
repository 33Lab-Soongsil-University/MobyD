// When the UI runs in a plain browser during development (no Tauri runtime),
// forward every `invoke` to the Rust dev bridge (`mobyd-devbridge`) so the
// screens work against real repositories. Never active inside the app.
import { mockIPC } from "@tauri-apps/api/mocks";

export function installDevBridge(): boolean {
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && !(window as { __MOBYD_BRIDGE__?: boolean }).__MOBYD_BRIDGE__;
  const url = import.meta.env.VITE_DEVBRIDGE as string | undefined;
  if (inTauri || !url || !import.meta.env.DEV) return false;
  (window as { __MOBYD_BRIDGE__?: boolean }).__MOBYD_BRIDGE__ = true;
  mockIPC(async (cmd, payload) => {
    const res = await fetch(`${url}/invoke/${encodeURIComponent(cmd)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
    const body = await res.json();
    if (!res.ok) throw body;
    return body;
  });
  return true;
}
