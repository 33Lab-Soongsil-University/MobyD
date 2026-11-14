import { useEffect, useState } from "react";
import { api, errorText } from "./lib/api";
import { useUi, toast } from "./store";
import { TopBar } from "./components/TopBar";
import { RepoManager } from "./components/RepoManager";
import { RepoView } from "./components/RepoView";
import { Toasts } from "./components/Toasts";
import { DialogHost } from "./components/DialogHost";
import { ContextMenu } from "./components/ContextMenu";
import { PreferencesModal } from "./components/prefs/PreferencesModal";
import { openRepoDialog } from "./lib/actions";
import { runSelftestIfRequested } from "./lib/selftest";
import type { RepoInfo } from "./lib/types";
import { t } from "./lib/i18n";
import { handleZoomKey } from "./lib/zoom";
import { ZoomIndicator } from "./components/ZoomIndicator";
import { CommandPalette } from "./components/CommandPalette";
import { startLinkHandling } from "./lib/deeplink";

function remotePlaceholder(uri: string): RepoInfo {
  const rest = uri.slice("ssh://".length);
  const host = rest.split("/")[0];
  const raw = rest.slice(host.length + 1);
  const path = /^[A-Za-z]:/.test(raw) ? raw : "/" + raw;
  const name = path.replace(/\/+$/, "").split("/").pop() || path;
  return { root: uri, name: `${name} @ ${host}`, gitDir: "", commonDir: "", isWorktree: false, host, path };
}

export default function App() {
  const tabs = useUi((s) => s.tabs);
  const active = useUi((s) => s.active);
  const modal = useUi((s) => s.modal);
  const restored = useUi((s) => s.restored);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const s = await api.settings();
        const infos: RepoInfo[] = [];
        for (const p of s.openTabs ?? []) {
          if (p.startsWith("ssh://")) {
            // Don't block start-up on the network: the tab connects (and can retry) on its own.
            infos.push(remotePlaceholder(p));
            continue;
          }
          try {
            infos.push(await api.openRepo(p));
          } catch {
            /* repository moved or deleted since last session */
          }
        }
        const act = infos.find((i) => i.root === s.activeTab)?.root ?? infos[0]?.root ?? null;
        useUi.getState().setTabs(infos, act);
      } catch (e) {
        toast.error(t("설정을 불러오지 못했습니다"), errorText(e));
        useUi.setState({ restored: true });
      } finally {
        setReady(true);
      }
      startLinkHandling().catch(() => {});
      runSelftestIfRequested().catch(() => {});
    })();
  }, []);

  useEffect(() => {
    if (ready && restored) api.saveTabs(tabs.map((t) => t.root), active).catch(() => {});
  }, [tabs, active, ready, restored]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (handleZoomKey(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        openRepoDialog();
      } else if (mod && e.key.toLowerCase() === "t") {
        e.preventDefault();
        useUi.setState({ active: null, managerTab: "open" });
      } else if (mod && e.key === ",") {
        e.preventDefault();
        useUi.setState({ modal: "prefs", prefsTab: "general" });
      } else if (mod && /^[1-9]$/.test(e.key)) {
        const t = useUi.getState().tabs[Number(e.key) - 1];
        if (t) {
          e.preventDefault();
          useUi.getState().setActive(t.root);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <TopBar />
      <main className="app-main">
        {ready && !active && <RepoManager />}
        {tabs.map((t) => (
          <div key={t.root} className="repo-host" hidden={t.root !== active}>
            <RepoView info={t} active={t.root === active} />
          </div>
        ))}
      </main>
      <Toasts />
      <ZoomIndicator />
      <CommandPalette />
      <DialogHost />
      <ContextMenu />
      {modal === "prefs" && <PreferencesModal />}
    </div>
  );
}
