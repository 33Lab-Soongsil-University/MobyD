// GitKraken-style command palette (⌘K / ⌘P): type a few letters to run any
// action, check out a branch, or jump to a repository.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Command, CornerDownLeft, FolderGit2, Search } from "lucide-react";
import { api } from "../lib/api";
import { initRepoDialog, openRepoDialog, openRepoPath } from "../lib/actions";
import { applyTheme } from "../lib/theme";
import { LANG_SWITCH, getLangPref, setLangPref, t } from "../lib/i18n";
import { resetZoom, zoomIn, zoomOut } from "../lib/zoom";
import { openManager, openPrefs, useUi } from "../store";
import { useEscape } from "../lib/escape";
import type { RecentRepo } from "../lib/types";

export interface PaletteCommand {
  id: string;
  title: string;
  /** Group shown on the right ("Branch", "Repository"…). */
  group: string;
  keys?: string;
  icon?: ReactNode;
  /** Extra words that should match (English names, synonyms). */
  words?: string;
  run: () => unknown;
  disabled?: boolean;
}

let repoCommands: (() => PaletteCommand[]) | null = null;

/** The active repository tab registers its commands here. */
export function setRepoCommands(fn: (() => PaletteCommand[]) | null) {
  repoCommands = fn;
}

export function openPalette() {
  window.dispatchEvent(new Event("mobyd-palette"));
}

function appCommands(recent: RecentRepo[]): PaletteCommand[] {
  const g = t("앱");
  const ui = useUi.getState();
  const list: PaletteCommand[] = [
    { id: "open", title: t("저장소 열기…"), group: g, keys: "⌘O", words: "open repository", run: openRepoDialog },
    { id: "clone", title: t("저장소 복제…"), group: g, words: "clone", run: () => openManager("clone") },
    { id: "init", title: t("새 저장소 만들기"), group: g, words: "init new repository", run: initRepoDialog },
    { id: "newtab", title: t("새 탭"), group: g, keys: "⌘T", words: "new tab", run: () => openManager("open") },
    { id: "prefs", title: t("환경설정"), group: g, keys: "⌘,", words: "preferences settings", run: () => openPrefs("general") },
    { id: "accounts", title: t("GitHub · GitLab · Gitea 계정 연결"), group: g, words: "integrations account login sign in", run: () => openPrefs("integrations") },
    { id: "ssh", title: t("SSH 원격 설정"), group: g, words: "ssh remote hosts", run: () => openPrefs("ssh") },
    { id: "theme-dark", title: t("테마: 다크"), group: g, words: "theme dark", run: () => applyTheme("dark") },
    { id: "theme-light", title: t("테마: 라이트"), group: g, words: "theme light", run: () => applyTheme("light") },
    { id: "theme-system", title: t("테마: 시스템 설정 따르기"), group: g, words: "theme system", run: () => applyTheme("system") },
    { id: "zoom-in", title: t("화면 확대"), group: g, keys: "⌘+", words: "zoom in bigger", run: zoomIn },
    { id: "zoom-out", title: t("화면 축소"), group: g, keys: "⌘−", words: "zoom out smaller", run: zoomOut },
    { id: "zoom-reset", title: t("화면 기본 크기"), group: g, keys: "⌘0", words: "zoom reset actual size", run: resetZoom },
    {
      id: "lang",
      title: getLangPref() === "en" ? LANG_SWITCH.toKo : LANG_SWITCH.toEn,
      group: g,
      words: LANG_SWITCH.words,
      run: () => setLangPref(getLangPref() === "en" ? "ko" : "en"),
    },
  ];
  ui.tabs.forEach((tab, i) =>
    list.push({
      id: `tab-${tab.root}`,
      title: t("탭으로 이동: {name}", { name: tab.name }),
      group: t("저장소"),
      keys: i < 9 ? `⌘${i + 1}` : undefined,
      icon: <FolderGit2 size={14} />,
      words: tab.root,
      run: () => ui.setActive(tab.root),
    }),
  );
  recent
    .filter((r) => !ui.tabs.some((tab) => tab.root === r.path))
    .slice(0, 15)
    .forEach((r) =>
      list.push({
        id: `recent-${r.path}`,
        title: t("최근 저장소 열기: {name}", { name: r.name }),
        group: t("저장소"),
        icon: <FolderGit2 size={14} />,
        words: r.path,
        run: () => openRepoPath(r.path),
      }),
    );
  return list;
}

/** Subsequence match with a bonus for word starts and consecutive letters; -1 when it does not match. */
export function score(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const s = text.toLowerCase();
  let si = 0;
  let total = 0;
  let run = 0;
  for (const ch of q) {
    const at = s.indexOf(ch, si);
    if (at < 0) return -1;
    run = at === si ? run + 1 : 0;
    const wordStart = at === 0 || /[\s/:_\-.·(]/.test(s[at - 1]);
    total += 1 + run * 2 + (wordStart ? 3 : 0) - Math.min(at - si, 5) * 0.2;
    si = at + 1;
  }
  return total - s.length * 0.01;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [recent, setRecent] = useState<RecentRepo[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const show = () => {
      setQuery("");
      setIndex(0);
      setOpen(true);
      api.settings().then((s) => setRecent(s.recent ?? [])).catch(() => {});
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key.toLowerCase() === "k" || e.key.toLowerCase() === "p")) {
        e.preventDefault();
        show();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mobyd-palette", show);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mobyd-palette", show);
    };
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  const items = useMemo(() => {
    if (!open) return [];
    const all = [...(repoCommands?.() ?? []), ...appCommands(recent)].filter((c) => !c.disabled);
    if (!query.trim()) return all;
    return all
      .map((c) => ({ c, s: Math.max(score(query, c.title), score(query, `${c.words ?? ""} ${c.group}`) - 2) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }, [open, query, recent]);

  useEffect(() => {
    list.current?.querySelector(".palette-item.on")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  useEscape(() => setOpen(false), open);

  if (!open) return null;
  const run = (c: PaletteCommand | undefined) => {
    if (!c) return;
    setOpen(false);
    setTimeout(() => c.run(), 0);
  };

  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="palette" role="dialog" aria-label={t("명령 찾기")}>
        <label className="palette-search">
          <Search size={16} />
          <input
            ref={input}
            value={query}
            placeholder={t("무엇을 할까요? 명령·브랜치·저장소 이름을 입력하세요")}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(items[index]);
              }
            }}
          />
          <kbd>esc</kbd>
        </label>
        <div className="palette-list" ref={list}>
          {items.length === 0 && <p className="muted pad">{t("맞는 명령이 없습니다.")}</p>}
          {items.slice(0, 80).map((c, i) => (
            <button key={c.id} className={"palette-item" + (i === index ? " on" : "")} onMouseMove={() => setIndex(i)} onClick={() => run(c)}>
              <span className="palette-icon">{c.icon ?? <Command size={14} />}</span>
              <span className="flex1 ellipsis">{c.title}</span>
              <span className="muted tiny">{c.group}</span>
              {c.keys && <kbd>{c.keys}</kbd>}
              {i === index && <CornerDownLeft size={13} className="muted" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

