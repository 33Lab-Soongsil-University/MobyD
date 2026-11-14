// In-app end-to-end self-test. Inert unless the app was started with
// MOBYD_SELFTEST_OUT / MOBYD_SELFTEST_REPO (see `selftest_config`).
// It drives the real UI inside the real webview and reports what it saw.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyTheme } from "./theme";
import { openRepoPath } from "./actions";
import { openManager, openPrefs, useUi } from "../store";
import { lang, setLangPref, t, type Lang } from "./i18n";
import { getZoom, resetZoom, zoomIn } from "./zoom";
import { humanize } from "./errors";

interface Check {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | null | undefined | false, ms = 15000): Promise<T> {
  const start = performance.now();
  while (performance.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await wait(50);
  }
  throw new Error("timed out");
}

const activeHost = () => [...document.querySelectorAll<HTMLElement>(".repo-host")].find((h) => !h.hidden) ?? null;

/**
 * Reload the page again and again while many backend requests are still in
 * flight, so their answers arrive for requests the page has already dropped.
 * The app must survive this (it is what a language switch or ⌘R mid-load does).
 */
async function reloadStress(repo: string, rounds: number) {
  const KEY = "mobyd.stress";
  let done = 0;
  try {
    done = Number(sessionStorage.getItem(KEY) ?? "0");
  } catch {
    /* ignore */
  }
  if (done >= rounds) {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    await invoke("selftest_finish", { report: JSON.stringify({ ok: true, reloads: done, checks: [] }, null, 2) });
    return;
  }
  try {
    sessionStorage.setItem(KEY, String(done + 1));
  } catch {
    /* ignore */
  }
  for (let i = 0; i < 24; i++) {
    invoke("repo_graph", { repo, limit: 2000, showStashes: true }).catch(() => {});
    invoke("repo_status", { repo }).catch(() => {});
  }
  await wait(5 + (done % 7) * 6);
  location.reload();
}

export async function runSelftestIfRequested() {
  let cfg: { repo: string; remote: string | null; lang: Lang | null; stress: number | null } | null = null;
  try {
    cfg = await invoke("selftest_config");
  } catch {
    return;
  }
  if (!cfg) return;
  if (cfg.stress) {
    await reloadStress(cfg.repo, cfg.stress);
    return;
  }
  if (cfg.lang && cfg.lang !== lang()) {
    setLangPref(cfg.lang); // reloads the page; the self-test starts again in that language
    return;
  }
  const checks: Check[] = [];
  const check = async (name: string, fn: () => Promise<string | void>) => {
    const t0 = performance.now();
    try {
      const detail = await fn();
      checks.push({ name, ok: true, ms: Math.round(performance.now() - t0), detail: detail ?? undefined });
    } catch (e) {
      checks.push({ name, ok: false, ms: Math.round(performance.now() - t0), detail: String(e instanceof Error ? e.message : e) });
    }
  };

  await wait(800);
  await check("open local repository and render graph", async () => {
    await openRepoPath(cfg!.repo);
    const rows = await until(() => {
      const n = activeHost()?.querySelectorAll(".g-row").length ?? 0;
      return n > 0 && n;
    });
    const paths = activeHost()!.querySelectorAll("svg.graph-cell path").length;
    if (paths === 0) throw new Error("graph SVG has no lane paths");
    return `${rows} rows, ${paths} lane paths`;
  });

  await check("work-in-progress panel", async () => {
    const host = activeHost()!;
    host.querySelector(".g-row.k-wip")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await until(() => host.querySelector(".commit-box"));
    return `${host.querySelectorAll(".wip .file-row").length} changed files listed`;
  });

  await check("commit details, diff and blame", async () => {
    const host = activeHost()!;
    const row = [...host.querySelectorAll<HTMLElement>(".g-row")].find((r) => !r.className.includes("k-"))!;
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const subject = await until(() => host.querySelector(".commit-subject")?.textContent);
    (await until(() => host.querySelector<HTMLElement>(".detail .files .file-row"))).click();
    await until(() => host.querySelector(".diff-table"));
    [...host.querySelectorAll<HTMLButtonElement>(".diff .btn.sm")].find((b) => b.textContent === "Blame")!.click();
    const lines = await until(() => host.querySelectorAll(".blame-table tr").length);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    return `${subject} · blame ${lines} lines`;
  });

  await check("interactive rebase editor", async () => {
    const host = activeHost()!;
    const rows = [...host.querySelectorAll<HTMLElement>(".g-row")].filter((r) => !r.className.includes("k-"));
    const base = rows[Math.min(2, rows.length - 1)];
    const rect = base.getBoundingClientRect();
    base.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: rect.left + 300, clientY: rect.top + 10 }));
    (await until(() => [...document.querySelectorAll<HTMLElement>(".menu-item")].find((i) => i.textContent?.includes(t("인터랙티브 리베이스"))))).click();
    const n = await until(() => document.querySelectorAll(".rebase-row").length);
    [...document.querySelectorAll<HTMLButtonElement>(".rebase .btn")].find((b) => b.textContent === t("취소"))!.click();
    return `${n} commits in the plan`;
  });

  await check("GitKraken-style layout: toolbar, left panel, graph columns, context menus", async () => {
    const host = activeHost()!;
    const texts = (sel: string, root: ParentNode = host) => [...root.querySelectorAll<HTMLElement>(sel)].map((e) => e.textContent?.trim() ?? "");
    const need = (what: string, have: string[], want: string[]) => {
      const missing = want.filter((w) => !have.some((h) => h.includes(w)));
      if (missing.length) throw new Error(`${what} is missing: ${missing.join(", ")} (has: ${have.join(" | ")})`);
    };
    const menu = async (el: Element, x = 40) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + x, clientY: r.top + 8 }));
      const items = await until(() => {
        const list = texts(".menu .menu-item", document);
        return list.length ? list : null;
      });
      useUi.getState().setMenu(null);
      await wait(50);
      return items;
    };
    // toolbar: repository ▾ · branch ▾ | undo redo | pull push | branch | stash pop | terminal
    if (!host.querySelector(".toolbar .repo-name") || !host.querySelector(".toolbar .branch-pill")) throw new Error("repository/branch selectors missing");
    const tools = texts(".toolbar .tool");
    need("toolbar", tools, [t("실행 취소"), t("다시 실행"), "Pull", "Push", t("브랜치"), "Stash", "Pop", t("터미널")]);
    // left panel sections
    const sections = texts(".sb-head");
    need("left panel", sections, [t("로컬"), t("원격"), t("워크트리"), "Stash", t("태그")]);
    if (!sections.some((x) => x.includes(t("풀 리퀘스트")) || x.includes(t("머지 리퀘스트")))) throw new Error("pull request section missing");
    // graph columns + WIP/stash rows
    need("graph header", texts(".g-header > *"), [t("브랜치 / 태그"), t("그래프"), t("커밋 메시지"), t("작성자"), t("날짜"), "SHA"]);
    if (!host.querySelector(".g-row.k-wip") || !host.querySelector(".g-row.k-stash")) throw new Error("WIP or stash row missing from the graph");
    // context menus
    const cur = host.querySelector(".branch-pill span")?.textContent?.trim() ?? "";
    const commitRow = [...host.querySelectorAll<HTMLElement>(".g-row")].find((r) => !r.className.includes("k-"))!;
    need("commit menu", await menu(commitRow, 300), [
      t("이 커밋 체크아웃 (분리된 HEAD)"),
      t("여기서 새 브랜치…"),
      t("여기서 워크트리…"),
      t("태그 만들기…"),
      t("'{cur}'에 체리픽", { cur }),
      t("'{cur}'에 병합…", { cur }),
      t("여기부터 인터랙티브 리베이스…"),
      t("되돌리기 커밋 (revert)"),
      "reset",
      t("SHA 복사"),
    ]);
    const item = (section: string, name: string) =>
      [...host.querySelectorAll<HTMLElement>(".sb-item")].find(
        (i) => i.closest(".sb-section")?.querySelector(".sb-head")?.textContent?.startsWith(section) && i.textContent?.includes(name),
      );
    const branch = item(t("로컬"), "develop");
    if (!branch) throw new Error("local branch 'develop' not in the left panel");
    need("branch menu", await menu(branch), [
      t("'{name}' 체크아웃", { name: "develop" }),
      t("워크트리로 열기…"),
      t("풀 리퀘스트 만들기…"),
      t("업스트림 설정…"),
      t("이름 바꾸기…"),
      t("삭제…"),
      t("이름 복사"),
    ]);
    const stash = [...host.querySelectorAll<HTMLElement>(".sb-section")].find((sec) => sec.querySelector(".sb-head")?.textContent?.startsWith("Stash"));
    if (stash && !stash.querySelector(".sb-item")) stash.querySelector<HTMLElement>(".sb-head")!.click();
    const stashItem = await until(() => stash?.querySelector(".sb-item"));
    need("stash menu", await menu(stashItem), [t("적용 (apply)"), t("꺼내기 (pop)"), t("삭제…")]);
    // repository switcher (GitKraken's repository ▾)
    host.querySelector<HTMLElement>(".toolbar .repo-name")!.click();
    const repoItems = await until(() => {
      const list = texts(".menu .menu-item", document);
      return list.length ? list : null;
    });
    useUi.getState().setMenu(null);
    need("repository menu", repoItems, [t("저장소 열기…"), t("저장소 복제…")]);
    return `toolbar ${tools.length} tools · ${sections.length} panel sections · 6 graph columns · commit/branch/stash/repository menus`;
  });

  await check("command palette, zoom and readable errors", async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true }));
    const items = await until(() => document.querySelectorAll(".palette-item").length);
    const input = document.querySelector<HTMLInputElement>(".palette-search input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "push");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(80);
    const top = document.querySelector(".palette-item")?.textContent ?? "";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    if (!/push/i.test(top)) throw new Error(`palette search for "push" showed: ${top}`);
    await zoomIn();
    const zoomed = getZoom();
    await resetZoom();
    if (zoomed <= 1 || getZoom() !== 1) throw new Error(`zoom did not change (${zoomed})`);
    const msg = humanize("git push: ! [rejected] main -> main (fetch first)\nhint: Updates were rejected").message;
    if (/rejected\]|hint:/.test(msg)) throw new Error(`error not translated: ${msg}`);
    return `${items} commands · "push" → ${top.trim().slice(0, 40)} · zoom ${Math.round(zoomed * 100)}% → 100% · ${msg.slice(0, 40)}…`;
  });

  await check("commit then undo/redo through the toolbar", async () => {
    const host = activeHost()!;
    host.querySelector(".g-row.k-wip")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const stageAll = await until(() => [...host.querySelectorAll<HTMLButtonElement>(".wip .btn.xs")].find((b) => b.textContent?.includes(t("모두 스테이징"))));
    stageAll.click();
    await until(() => host.querySelectorAll(".wip .stage-box")[1]?.querySelector(".file-row"));
    const input = host.querySelector<HTMLInputElement>(".summary-row input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Selftest commit");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(100);
    host.querySelector<HTMLButtonElement>(".commit-box button[type=submit]")!.click();
    await until(() => [...host.querySelectorAll(".c-msg")].some((m) => m.textContent === "Selftest commit"));
    const undo = await until(() => [...host.querySelectorAll<HTMLButtonElement>(".tool")].find((b) => b.textContent?.includes(t("실행 취소")) && !b.disabled));
    undo.click();
    await until(() => ![...host.querySelectorAll(".c-msg")].some((m) => m.textContent === "Selftest commit"));
    const redo = await until(() => [...host.querySelectorAll<HTMLButtonElement>(".tool")].find((b) => b.textContent?.includes(t("다시 실행")) && !b.disabled));
    redo.click();
    await until(() => [...host.querySelectorAll(".c-msg")].some((m) => m.textContent === "Selftest commit"));
    return "commit → undo → redo";
  });

  await check("themes: light, dark, system + native window theme", async () => {
    const bg = () => getComputedStyle(document.body).backgroundColor;
    applyTheme("light");
    await wait(80);
    const light = bg();
    await getCurrentWindow().setTheme("light");
    applyTheme("dark");
    await wait(80);
    const dark = bg();
    await getCurrentWindow().setTheme("dark");
    applyTheme("system");
    await getCurrentWindow().setTheme(null);
    if (light === dark) throw new Error(`theme did not change background (${light})`);
    return `light ${light} / dark ${dark} / system follows ${window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"}`;
  });

  await check("preferences and repository manager", async () => {
    openPrefs("ssh");
    const hosts = await until(() => document.querySelectorAll(".prefs .account").length || document.querySelector(".prefs .muted") !== null);
    let hostPrefs = "no hosts";
    const gear = document.querySelector<HTMLButtonElement>(`.ssh-host-card button[title="${t("이 호스트 설정")}"]`);
    if (gear) {
      gear.click(); // opens the per-host panel only; nothing connects
      const modes = await until(() => document.querySelectorAll(".ssh-host-prefs .seg button").length);
      hostPrefs = `host settings panel with ${modes} shell modes`;
    }
    useUi.getState().setModal(null);
    openPrefs("integrations");
    const integrationServices = await until(() => document.querySelectorAll(".prefs .service-list > button").length);
    const prefsNav = document.querySelectorAll(".prefs-nav button").length;
    if (prefsNav < 4 || integrationServices < 5) throw new Error(`preferences: ${prefsNav} pages, ${integrationServices} integration services`);
    useUi.getState().setModal(null);
    openManager("clone", "github");
    const services = await until(() => document.querySelectorAll(".manager .service-list > button").length);
    const connect = await until(() => document.querySelector(".manager .connect-card, .manager .account-repos"));
    const browserLogin = !!connect.querySelector(".connect-actions .btn.primary") || connect.classList.contains("account-repos");
    if (!browserLogin) throw new Error("GitHub.com has neither a browser sign-in button nor a repository list");
    const tabs = useUi.getState().tabs;
    useUi.getState().setActive(tabs[tabs.length - 1].root);
    return `ssh hosts listed: ${hosts} · ${hostPrefs} · ${prefsNav} preference pages, ${integrationServices} integration services · clone sources ${services}, GitHub browser sign-in ready`;
  });

  if (cfg.remote) {
    await check("open SSH repository and render graph", async () => {
      await openRepoPath(cfg!.remote!);
      const rows = await until(() => {
        const h = activeHost();
        const n = h?.querySelectorAll(".g-row").length ?? 0;
        return h?.querySelector(".host-chip") && n > 0 && n;
      }, 30000);
      return `${rows} rows over SSH`;
    });
  }

  const report = {
    ok: checks.every((c) => c.ok),
    userAgent: navigator.userAgent,
    tauri: "__TAURI_INTERNALS__" in window,
    lang: lang(),
    // what the toolbar actually showed, as evidence of the UI language
    toolbar: [...document.querySelectorAll(".toolbar .tool")].map((b) => b.textContent?.trim()).filter(Boolean),
    checks,
  };
  await invoke("selftest_finish", { report: JSON.stringify(report, null, 2) });
}
