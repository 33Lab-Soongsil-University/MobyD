import { UpdateButton } from "./UpdateButton";
import { Plus, X, FolderGit2, GitFork, Server, Settings, UserRound, Search, CircleHelp } from "lucide-react";
import { startTour } from "./Tour";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Account } from "../lib/types";
import { openManager, openPrefs, useUi } from "../store";
import { WhaleMark } from "./Logo";
import { openPalette } from "./CommandPalette";
import { MidEllipsis } from "./MidEllipsis";
import { displayRoot, repoBaseName } from "../lib/format";
import { t as tr } from "../lib/i18n";

export function TopBar() {
  const tabs = useUi((s) => s.tabs);
  const active = useUi((s) => s.active);
  const setActive = useUi((s) => s.setActive);
  const closeTab = useUi((s) => s.closeTab);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const accountsVersion = useUi((s) => s.accountsVersion);
  useEffect(() => {
    api.accounts().then(setAccounts).catch(() => {});
  }, [accountsVersion]);
  const me = accounts[0];
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    nav.current?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <WhaleMark size={28} />
        <span data-tauri-drag-region>MobyD</span>
      </div>
      <nav className="tabs" ref={nav} data-tauri-drag-region>
        {tabs.map((t) => (
          <div
            key={t.root}
            className={"tab" + (t.root === active ? " active" : "")}
            onClick={() => setActive(t.root)}
            onAuxClick={(e) => e.button === 1 && closeTab(t.root)}
            title={displayRoot(t.root)}
          >
            {t.host ? <Server size={13} className="accent" /> : t.isWorktree ? <GitFork size={13} /> : <FolderGit2 size={13} />}
            <MidEllipsis className="tab-name" text={repoBaseName(t.name, t.host)} />
            {t.host && <span className="tab-host">{t.host}</span>}
            <button
              className="tab-close"
              aria-label={tr("탭 닫기")}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.root);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          className={"tab-new" + (active === null ? " active" : "")}
          title={tr("새 탭 (⌘T)")}
          onClick={() => openManager("open")}
        >
          <Plus size={14} />
          {active === null && <span>{tr("새 탭")}</span>}
        </button>
      </nav>
      <div className="topbar-right">
        <UpdateButton />
        <button className="palette-btn" onClick={openPalette} title={tr("명령 찾기 (⌘K)")}>
          <Search size={13} />
          <span>{tr("명령 찾기")}</span>
          <kbd>⌘K</kbd>
        </button>
        <button className="icon-btn" title={tr("기본 기능 둘러보기")} aria-label={tr("기본 기능 둘러보기")} onClick={startTour}>
          <CircleHelp size={16} />
        </button>
        <button className="icon-btn" title={tr("환경설정")} onClick={() => openPrefs("general")}>
          <Settings size={16} />
        </button>
        <button
          className="profile-btn"
          title={
            accounts.length
              ? accounts.map((a) => `${a.username} · ${new URL(a.baseUrl).host}`).join("\n")
              : tr("GitHub · GitLab · Gitea 계정 연결")
          }
          onClick={() => openPrefs("integrations")}
        >
          {me?.avatarUrl ? <img className="avatar img" src={me.avatarUrl} alt="" referrerPolicy="no-referrer" /> : <UserRound size={16} />}
          {accounts.length > 1 && <span className="profile-count">{accounts.length}</span>}
        </button>
      </div>
    </header>
  );
}
