import { useEffect, useMemo, useState } from "react";
import {
  FolderOpen,
  Server,
  CloudDownload,
  FolderPlus,
  Clock3,
  X,
  Search,
  Lock,
  GitFork,
  Loader2,
  ExternalLink,
  Settings,
  Laptop,
  RefreshCw,
  Link2,
  XCircle,
  CheckCircle2,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorText } from "../lib/api";
import type { Account, AppInfo, ForgeRepo, RecentRepo } from "../lib/types";
import { getCloneDir, initRepoDialog, isRemotePath, openRepoDialog, openRepoPath, pickDirectory, setCloneDir, sshUri } from "../lib/actions";
import { displayRoot, isoRelative, joinPath, relativeTime, repoBaseName } from "../lib/format";
import { MidEllipsis } from "./MidEllipsis";
import { ask, openPrefs, toast, useUi, type ManagerTab } from "../store";
import { WhaleHero } from "./Logo";
import { SshBrowser } from "./SshBrowser";
import { ForgeIcon, FORGE_LABEL } from "./ForgeIcon";
import { ConnectService, SERVICES, ServiceList, accountsFor, serviceOf } from "./Integrations";
import { t } from "../lib/i18n";

const remoteHost = (path: string) => (path.startsWith("ssh://") ? path.slice(6).split("/")[0] : null);
import { ErrorBox } from "./ErrorBox";

export function repoNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  return cleaned.split(/[/:]/).pop() || "repo";
}

function RecentList() {
  const [recent, setRecent] = useState<RecentRepo[]>([]);
  const tabs = useUi((s) => s.tabs);
  useEffect(() => {
    api.settings().then((s) => setRecent(s.recent ?? [])).catch(() => {});
  }, [tabs.length]);
  return (
    <section className="manager-card">
      <h2>
        <Clock3 size={14} />{" "}{t("최근 저장소")}</h2>
      {recent.length === 0 && <p className="muted">{t("아직 연 저장소가 없습니다.")}</p>}
      <ul className="recent">
        {recent.map((r) => (
          <li key={r.path} onClick={() => openRepoPath(r.path)} title={displayRoot(r.path)}>
            {isRemotePath(r.path) ? <Server size={15} className="accent" /> : <Laptop size={15} className="muted" />}
            <div>
              <strong className="recent-name">
                <MidEllipsis text={repoBaseName(r.name, remoteHost(r.path))} />
                {remoteHost(r.path) && <span className="host-chip">{remoteHost(r.path)}</span>}
              </strong>
              <MidEllipsis path className="muted mono tiny recent-path" text={displayRoot(r.path)} />
            </div>
            <span className="muted tiny">{relativeTime(r.lastOpened)}</span>
            <button
              className="icon-btn"
              title={t("목록에서 제거")}
              onClick={async (e) => {
                e.stopPropagation();
                setRecent((await api.removeRecent(r.path)).recent);
              }}
            >
              <X size={13} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function OpenPane() {
  const [ssh, setSsh] = useState(false);
  return (
    <div className="manager-pane">
      <div className="choice-row">
        <button className="choice" onClick={openRepoDialog} title={t("로컬 폴더의 Git 저장소 (⌘O)")}>
          <FolderOpen size={22} />
          <strong>{t("이 컴퓨터에서 열기")}</strong>
        </button>
        <button className={"choice" + (ssh ? " on" : "")} onClick={() => setSsh(!ssh)} title={t("~/.ssh/config의 호스트에서 폴더를 골라 로컬처럼 사용")}>
          <Server size={22} />
          <strong>{t("SSH로 연결된 PC에서 열기")}</strong>
        </button>
      </div>
      {ssh && (
        <section className="manager-card">
          <SshBrowser mode="open" onPick={(host, path) => openRepoPath(sshUri(host, path))} />
        </section>
      )}
      <RecentList />
    </div>
  );
}

type Dest = { kind: "local"; dir: string } | { kind: "ssh"; host: string; dir: string };

function DestinationPicker({ dest, setDest }: { dest: Dest; setDest: (d: Dest) => void }) {
  const [browsing, setBrowsing] = useState(false);
  return (
    <div className="field">
      <span>{t("복제할 위치")}</span>
      <div className="seg wide">
        <button className={dest.kind === "local" ? "on" : ""} onClick={() => setDest({ kind: "local", dir: getCloneDir() })}>
          <Laptop size={13} />{" "}{t("이 컴퓨터")}</button>
        <button className={dest.kind === "ssh" ? "on" : ""} onClick={() => setBrowsing(true)}>
          <Server size={13} />{" "}{t("SSH 원격 PC")}</button>
      </div>
      {dest.kind === "local" ? (
        <div className="input-row">
          <input className="mono" value={dest.dir} placeholder="/Users/me/code" onChange={(e) => setDest({ kind: "local", dir: e.target.value })} spellCheck={false} />
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const d = await pickDirectory(t("복제할 상위 폴더"));
              if (d) setDest({ kind: "local", dir: d });
            }}
          >{t("찾아보기")}</button>
        </div>
      ) : (
        <div className="input-row">
          <span className="chip">{dest.host}</span>
          <input className="mono" value={dest.dir} onChange={(e) => setDest({ ...dest, dir: e.target.value })} spellCheck={false} />
          <button type="button" className="btn" onClick={() => setBrowsing(true)}>{t("찾아보기")}</button>
        </div>
      )}
      {browsing && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setBrowsing(false)}>
          <div className="dialog wide xl">
            <div className="dialog-title-row">
              <h3>{t("원격 PC의 상위 폴더 선택")}</h3>
              <button className="icon-btn" onClick={() => setBrowsing(false)}>
                <X size={16} />
              </button>
            </div>
            <SshBrowser
              mode="select"
              onPick={(host, path) => {
                setDest({ kind: "ssh", host, dir: path });
                setBrowsing(false);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function destPath(dest: Dest, name: string) {
  return dest.kind === "local" ? joinPath(dest.dir, name) : sshUri(dest.host, joinPath(dest.dir, name));
}

async function cloneAndOpen(url: string, dest: Dest, name: string) {
  if (!dest.dir.trim()) {
    const d = await pickDirectory(t("복제할 상위 폴더"));
    if (!d) return false;
    dest = { kind: "local", dir: d };
    setCloneDir(d);
  }
  const target = destPath(dest, name);
  try {
    await api.cloneRepo(url, target);
    toast.success(t("복제했습니다"), target);
    await openRepoPath(target);
    return true;
  } catch (e) {
    toast.error(t("복제하지 못했습니다"), errorText(e));
    return false;
  }
}

function UrlClone() {
  const linked = useUi((s) => s.cloneUrl);
  const [url, setUrl] = useState(linked ?? "");
  useEffect(() => {
    if (linked) {
      setUrl(linked);
      useUi.setState({ cloneUrl: null });
    }
  }, [linked]);
  const [name, setName] = useState("");
  const [dest, setDest] = useState<Dest>({ kind: "local", dir: getCloneDir() });
  const [busy, setBusy] = useState(false);
  const folder = name || (url ? repoNameFromUrl(url) : "");
  return (
    <form
      className="manager-card form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!url.trim() || busy) return;
        setBusy(true);
        if (dest.kind === "local" && dest.dir) setCloneDir(dest.dir);
        await cloneAndOpen(url.trim(), dest, folder);
        setBusy(false);
      }}
    >
      <label className="field">
        <span>{t("저장소 URL")}</span>
        <input autoFocus className="mono" placeholder={t("https://github.com/owner/repo.git 또는 git@gitlab.com:group/repo.git")} value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
      </label>
      <DestinationPicker dest={dest} setDest={setDest} />
      <label className="field">
        <span>{t("폴더 이름")}</span>
        <input className="mono" placeholder={url ? repoNameFromUrl(url) : ""} value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        {folder && dest.dir && <small className="muted mono">{destPath(dest, folder)}</small>}
      </label>
      <div className="dialog-actions">
        <button type="submit" className="btn primary" disabled={!url.trim() || busy}>
          {busy ? <Loader2 size={14} className="spin" /> : <CloudDownload size={14} />} {busy ? t("복제 중…") : t("복제 후 열기")}
        </button>
      </div>
    </form>
  );
}

type CloneState = { status: "queued" | "cloning" | "done" | "failed"; detail?: string; path?: string };

/** Clone many repositories, a few at a time. */
async function cloneQueue(
  jobs: { key: string; url: string; folder: string }[],
  dest: Dest,
  onState: (key: string, st: CloneState) => void,
  parallel = 3,
) {
  let next = 0;
  let ok = 0;
  let failed = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      onState(job.key, { status: "cloning" });
      const target = destPath(dest, job.folder);
      try {
        await api.cloneRepo(job.url, target);
        ok++;
        onState(job.key, { status: "done", path: target });
      } catch (e) {
        failed++;
        onState(job.key, { status: "failed", detail: errorText(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));
  return { ok, failed };
}

function AccountRepos({ account }: { account: Account }) {
  const [repos, setRepos] = useState<ForgeRepo[] | null>(null);
  const [clones, setClones] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [owner, setOwner] = useState("");
  const [vis, setVis] = useState<"all" | "public" | "private">("all");
  const [hideArchived, setHideArchived] = useState(false);
  const [proto, setProto] = useState<"https" | "ssh">(() => (localStorage.getItem("mobyd.cloneProto") as "https" | "ssh") || "https");
  const [dest, setDest] = useState<Dest>({ kind: "local", dir: getCloneDir() });
  const [byOwner, setByOwner] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [jobs, setJobs] = useState<Record<string, CloneState>>({});
  const [running, setRunning] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancel = false;
    setRepos(null);
    setErr(null);
    setPicked(new Set());
    api
      .accountRepos(account.id)
      .then(async (r) => {
        if (cancel) return;
        setRepos(r);
        const found = await api.findLocalClones(r.flatMap((x) => [x.cloneHttps, x.cloneSsh]).filter(Boolean)).catch(() => ({}));
        if (!cancel) setClones(found);
      })
      .catch((e) => !cancel && setErr(errorText(e)));
    return () => {
      cancel = true;
    };
  }, [account.id, version]);

  const owners = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of repos ?? []) counts.set(r.owner, (counts.get(r.owner) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => (a[0] === account.username ? -1 : b[0] === account.username ? 1 : a[0].localeCompare(b[0])));
  }, [repos, account.username]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (repos ?? []).filter(
      (r) =>
        (!s || r.fullName.toLowerCase().includes(s) || r.description.toLowerCase().includes(s)) &&
        (!owner || r.owner === owner) &&
        (vis === "all" || (vis === "private") === r.private) &&
        (!hideArchived || !r.archived),
    );
  }, [repos, q, owner, vis, hideArchived]);

  const localOf = (r: ForgeRepo) => clones[r.cloneHttps] ?? clones[r.cloneSsh] ?? jobs[r.fullName]?.path;
  const cloneable = shown.filter((r) => !localOf(r));
  const allPicked = cloneable.length > 0 && cloneable.every((r) => picked.has(r.fullName));
  const urlOf = (r: ForgeRepo) => (proto === "ssh" && r.cloneSsh ? r.cloneSsh : r.cloneHttps);

  const folderFor = (r: ForgeRepo, names: Map<string, number>) =>
    byOwner ? `${r.owner}/${r.name}` : (names.get(r.name) ?? 0) > 1 ? `${r.owner}-${r.name}` : r.name;

  const cloneSelected = async (list: ForgeRepo[]) => {
    if (!list.length) return;
    let d = dest;
    if (!d.dir.trim()) {
      const dir = await pickDirectory(t("복제할 상위 폴더"));
      if (!dir) return;
      d = { kind: "local", dir };
      setDest(d);
    }
    if (d.kind === "local") setCloneDir(d.dir);
    const names = new Map<string, number>();
    for (const r of list) names.set(r.name, (names.get(r.name) ?? 0) + 1);
    setRunning(true);
    setJobs((j) => ({ ...j, ...Object.fromEntries(list.map((r) => [r.fullName, { status: "queued" } as CloneState])) }));
    const res = await cloneQueue(
      list.map((r) => ({ key: r.fullName, url: urlOf(r), folder: folderFor(r, names) })),
      d,
      (key, st) => setJobs((j) => ({ ...j, [key]: st })),
    );
    setRunning(false);
    setPicked(new Set());
    if (list.length === 1 && res.ok === 1) {
      await openRepoPath(destPath(d, folderFor(list[0], names)));
    } else if (res.failed) {
      toast.warning(t("{ok}개 복제, {failed}개 실패", { ok: res.ok, failed: res.failed }), t("실패한 저장소에 마우스를 올리면 이유가 보입니다."));
    } else {
      toast.success(t("저장소 {n}개를 복제했습니다", { n: res.ok }), d.kind === "local" ? d.dir : `${d.host}:${d.dir}`);
    }
  };

  const toggle = (name: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const selectedRepos = (repos ?? []).filter((r) => picked.has(r.fullName));

  return (
    <div className="manager-card account-repos">
      <div className="account-head">
        {account.avatarUrl ? <img className="avatar img" src={account.avatarUrl} alt="" referrerPolicy="no-referrer" /> : <ForgeIcon kind={account.kind} size={22} />}
        <div className="flex1">
          <strong>{account.username}</strong> <span className="muted tiny mono">{new URL(account.baseUrl).host}</span>
          <div className="muted tiny">
            {repos ? t("접근 가능한 저장소 {n}개", { n: repos.length }) : t("저장소를 불러오는 중…")}
          </div>
        </div>
        <button className="icon-btn" title={t("새로고침")} onClick={() => setVersion((v) => v + 1)} disabled={running}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="repo-list-head">
        <label className="search flex1">
          <Search size={13} />
          <input placeholder={t("이름·설명으로 검색")} value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
        </label>
        <select value={owner} onChange={(e) => setOwner(e.target.value)} title={t("소유자")}>
          <option value="">{t("모든 소유자 ({n})", { n: owners.length })}</option>
          {owners.map(([o, n]) => (
            <option key={o} value={o}>
              {o} ({n})
            </option>
          ))}
        </select>
        <div className="seg">
          {(["all", "public", "private"] as const).map((v) => (
            <button key={v} className={vis === v ? "on" : ""} onClick={() => setVis(v)}>
              {v === "all" ? t("전체") : v === "public" ? t("공개") : t("비공개")}
            </button>
          ))}
        </div>
        <div className="seg">
          {(["https", "ssh"] as const).map((p) => (
            <button
              key={p}
              className={proto === p ? "on" : ""}
              onClick={() => {
                setProto(p);
                localStorage.setItem("mobyd.cloneProto", p);
              }}
              title={p === "https" ? t("로그인한 계정으로 인증") : t("SSH 키로 인증")}
            >
              {p.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <DestinationPicker dest={dest} setDest={setDest} />
      <div className="bulk-bar">
        <label className="check">
          <input
            type="checkbox"
            checked={allPicked}
            disabled={!cloneable.length || running}
            onChange={() => setPicked(allPicked ? new Set() : new Set(cloneable.map((r) => r.fullName)))}
          />
          {t("보이는 저장소 모두 선택 ({n})", { n: cloneable.length })}
        </label>
        <label className="check muted tiny">
          <input type="checkbox" checked={hideArchived} onChange={(e) => setHideArchived(e.target.checked)} /> {t("보관된 저장소 숨기기")}
        </label>
        <label className="check muted tiny" title={t("예: 상위폴더/owner/repo")}>
          <input type="checkbox" checked={byOwner} onChange={(e) => setByOwner(e.target.checked)} /> {t("소유자별 폴더")}
        </label>
        <span className="flex1" />
        <button className="btn primary" disabled={!selectedRepos.length || running} onClick={() => cloneSelected(selectedRepos)}>
          {running ? <Loader2 size={13} className="spin" /> : <CloudDownload size={13} />}{" "}
          {running
            ? t("복제 중… {done}/{total}", {
                done: Object.values(jobs).filter((j) => j.status === "done" || j.status === "failed").length,
                total: Object.keys(jobs).length,
              })
            : t("선택한 {n}개 복제", { n: selectedRepos.length })}
        </button>
      </div>
      {err && <ErrorBox text={err} />}
      {!repos && !err && (
        <p className="muted pad">
          <Loader2 size={14} className="spin" /> {t("{service} 저장소를 불러오는 중…", { service: FORGE_LABEL[account.kind] })}
        </p>
      )}
      <div className="repo-list">
        {shown.map((r) => {
          const local = localOf(r);
          const job = jobs[r.fullName];
          return (
            <div key={r.fullName} className={"repo-row" + (picked.has(r.fullName) ? " picked" : "")}>
              <input
                type="checkbox"
                aria-label={r.fullName}
                checked={picked.has(r.fullName)}
                disabled={!!local || running}
                onChange={() => toggle(r.fullName)}
              />
              <div className="flex1 repo-row-main" onClick={() => !local && !running && toggle(r.fullName)}>
                <div>
                  <span className="muted">{r.owner}/</span>
                  <strong>{r.name}</strong>
                  {r.private && (
                    <span className="badge">
                      <Lock size={9} /> {t("비공개")}
                    </span>
                  )}
                  {r.fork && (
                    <span className="badge">
                      <GitFork size={9} /> fork
                    </span>
                  )}
                  {r.archived && <span className="badge warn">{t("보관됨")}</span>}
                </div>
                {r.description && <div className="muted tiny ellipsis">{r.description}</div>}
              </div>
              <span className="muted tiny">{isoRelative(r.updatedAt)}</span>
              <button className="icon-btn" title={t("웹에서 보기")} onClick={() => openUrl(r.webUrl).catch(() => {})}>
                <ExternalLink size={13} />
              </button>
              {job?.status === "queued" ? (
                <span className="badge">{t("대기")}</span>
              ) : job?.status === "cloning" ? (
                <span className="badge">
                  <Loader2 size={10} className="spin" /> {t("복제 중")}
                </span>
              ) : job?.status === "failed" ? (
                <span className="badge warn" title={job.detail}>
                  <XCircle size={10} /> {t("실패")}
                </span>
              ) : local ? (
                <button className="btn sm primary" onClick={() => openRepoPath(local)} title={local}>
                  {job?.status === "done" ? <CheckCircle2 size={12} /> : null} {t("열기")}
                </button>
              ) : (
                <button className="btn sm" disabled={running} onClick={() => cloneSelected([r])}>
                  <CloudDownload size={12} /> {t("복제")}
                </button>
              )}
            </div>
          );
        })}
        {repos && shown.length === 0 && <p className="muted pad">{t("검색 결과가 없습니다.")}</p>}
      </div>
    </div>
  );
}

function ClonePane() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const requested = useUi((s) => s.cloneSource);
  const [source, setSource] = useState<string>(requested ?? "github");
  const version = useUi((s) => s.accountsVersion);
  useEffect(() => {
    api.accounts().then(setAccounts).catch(() => {});
  }, [version]);
  useEffect(() => {
    if (requested) setSource(requested);
  }, [requested]);

  // A source is "url", a service id, or an account id (for services with several accounts).
  const account = accounts.find((a) => a.id === source);
  const service = account ? serviceOf(account) : SERVICES.find((s) => s.id === source);
  const serviceAccounts = service ? accountsFor(service, accounts) : [];
  const shownAccount = account ?? serviceAccounts[0];

  return (
    <div className="manager-pane clone-pane">
      <ServiceList
        accounts={accounts}
        selected={source === "url" ? "url" : (service?.id ?? "")}
        onSelect={(id) => setSource(id)}
        extra={
          <button className={source === "url" ? "on" : ""} onClick={() => setSource("url")}>
            <Link2 size={16} />
            <span className="flex1">{t("URL로 복제")}</span>
          </button>
        }
      />
      <div className="clone-main">
        {source === "url" || !service ? (
          <UrlClone />
        ) : shownAccount ? (
          <>
            {serviceAccounts.length > 1 && (
              <div className="seg wide account-switch">
                {serviceAccounts.map((a) => (
                  <button key={a.id} className={a.id === shownAccount.id ? "on" : ""} onClick={() => setSource(a.id)}>
                    {a.username} <span className="muted tiny">{new URL(a.baseUrl).host}</span>
                  </button>
                ))}
              </div>
            )}
            <AccountRepos account={shownAccount} />
          </>
        ) : (
          <div className="manager-card">
            <ConnectService service={service} onConnected={(list) => setAccounts(list)} />
          </div>
        )}
      </div>
    </div>
  );
}

function InitPane() {
  const [ssh, setSsh] = useState(false);
  return (
    <div className="manager-pane">
      <div className="choice-row">
        <button className="choice" onClick={initRepoDialog} title={t("폴더를 골라 git init -b main")}>
          <FolderPlus size={22} />
          <strong>{t("이 컴퓨터에 새 저장소")}</strong>
        </button>
        <button className={"choice" + (ssh ? " on" : "")} onClick={() => setSsh(!ssh)} title={t("원격 폴더 안에 새 저장소를 만들고 바로 엽니다")}>
          <Server size={22} />
          <strong>{t("SSH 원격 PC에 새 저장소")}</strong>
        </button>
      </div>
      {ssh && (
        <section className="manager-card">
          <SshBrowser
            mode="select"
            onPick={async (host, path, isRepo) => {
              if (isRepo) {
                await openRepoPath(sshUri(host, path));
                return;
              }
              const v = await ask({
                title: t("{host}에 새 저장소", { host }),
                message: t("{path} 아래에 만듭니다.", { path }),
                fields: [{ name: "name", label: t("폴더 이름"), required: true, mono: true, placeholder: "my-project" }],
                confirmLabel: t("만들기"),
              });
              if (!v) return;
              const uri = sshUri(host, joinPath(path, String(v.name).trim()));
              try {
                await api.initRepo(uri);
                toast.success(t("원격 저장소를 만들었습니다"), uri);
                await openRepoPath(uri);
              } catch (e) {
                toast.error(t("만들지 못했습니다"), errorText(e));
              }
            }}
          />
        </section>
      )}
    </div>
  );
}

/** GitKraken-style repository management: the screen behind every new tab. */
export function RepoManager() {
  const tab = useUi((s) => s.managerTab);
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    api.appInfo().then(setInfo).catch(() => {});
  }, []);
  const nav: { id: ManagerTab; label: string; icon: React.ReactNode }[] = [
    { id: "open", label: t("열기"), icon: <FolderOpen size={16} /> },
    { id: "clone", label: t("복제"), icon: <CloudDownload size={16} /> },
    { id: "init", label: t("새로 만들기"), icon: <FolderPlus size={16} /> },
  ];
  return (
    <div className="manager">
      <aside className="manager-nav">
        <div className="manager-brand">
          <WhaleHero size={92} />
          <h1>MobyD</h1>
          <p className="muted tiny">{t("커밋 그래프를 헤엄치는 흰 고래")}</p>
        </div>
        {nav.map((n) => (
          <button key={n.id} className={tab === n.id ? "on" : ""} onClick={() => useUi.setState({ managerTab: n.id })}>
            {n.icon} {n.label}
          </button>
        ))}
        <span className="flex1" />
        <button onClick={() => openPrefs("general")}>
          <Settings size={16} />{" "}{t("환경설정")}</button>
        {info && <p className="tiny muted manager-foot">{info.gitVersion ?? t("git을 찾을 수 없습니다")}</p>}
      </aside>
      <main className="manager-body">
        {tab === "open" && <OpenPane />}
        {tab === "clone" && <ClonePane />}
        {tab === "init" && <InitPane />}
      </main>
    </div>
  );
}
