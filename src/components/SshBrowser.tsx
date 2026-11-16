import { useEffect, useState } from "react";
import { Server, Folder, FolderGit2, ArrowUp, Home, Loader2, RefreshCw, CornerDownLeft, SlidersHorizontal } from "lucide-react";
import { api, errorText } from "../lib/api";
import type { DirListing, SshHost } from "../lib/types";
import { openPrefs } from "../store";
import { t } from "../lib/i18n";
import { MidEllipsis } from "./MidEllipsis";
import { ErrorBox } from "./ErrorBox";

/**
 * Browse folders on an SSH host. `onPick(host, path, isRepo)` fires for the
 * folder the user chooses ("open" for repositories, "select" for clone/init targets).
 */
export function SshBrowser({
  mode,
  onPick,
}: {
  mode: "open" | "select";
  onPick: (host: string, path: string, isRepo: boolean) => void;
}) {
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [host, setHost] = useState<string | null>(() => {
    try {
      return localStorage.getItem("mobyd.sshHost");
    } catch {
      return null;
    }
  });
  const [listing, setListing] = useState<DirListing | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.sshHosts().then(setHosts).catch((e) => setErr(errorText(e)));
  }, []);

  const go = async (h: string, path: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      const l = await api.sshListDir(h, path);
      setListing(l);
      setTyped(l.path);
      try {
        localStorage.setItem("mobyd.sshHost", h);
        localStorage.setItem(`mobyd.sshPath.${h}`, l.path);
      } catch {
        /* ignore */
      }
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!host) return;
    let last: string | null = null;
    try {
      last = localStorage.getItem(`mobyd.sshPath.${host}`);
    } catch {
      /* ignore */
    }
    go(host, last);
  }, [host]); // eslint-disable-line react-hooks/exhaustive-deps

  const join = (base: string, name: string) => (base.endsWith("/") ? base + name : `${base}/${name}`);

  return (
    <div className="ssh-browser">
      <aside className="ssh-hosts">
        <div className="pane-label">{t("SSH 호스트")}</div>
        {hosts.length === 0 && <p className="sb-empty">{t("~/.ssh/config에 호스트가 없습니다.")}</p>}
        {hosts.map((h) => (
          <button key={h.alias} className={"ssh-host" + (host === h.alias ? " on" : "")} onClick={() => setHost(h.alias)} title={`${h.user ?? ""}@${h.hostname ?? h.alias}`}>
            <Server size={14} />
            <span className="ellipsis">{h.alias}</span>
          </button>
        ))}
      </aside>
      <section className="ssh-dir">
        {!host && <p className="muted pad">{t("왼쪽에서 접속할 PC를 고르세요.")}</p>}
        {host && (
          <>
            <div className="ssh-path">
              <button className="icon-btn" title={t("홈")} onClick={() => go(host, null)}>
                <Home size={14} />
              </button>
              <button className="icon-btn" title={t("상위 폴더")} disabled={!listing?.parent} onClick={() => listing?.parent && go(host, listing.parent)}>
                <ArrowUp size={14} />
              </button>
              <form
                className="flex1 input-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (typed.trim()) go(host, typed.trim());
                }}
              >
                <input className="mono" value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} placeholder="/home/me/code" />
                <button className="icon-btn" title={t("이동")} type="submit">
                  <CornerDownLeft size={14} />
                </button>
              </form>
              <button className="icon-btn" title={t("새로고침")} onClick={() => go(host, listing?.path ?? null)}>
                {busy ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
              </button>
            </div>
            {listing && (
              <div className="ssh-meta tiny muted">
                {host} · {listing.os || "?"} · {listing.shell} · {listing.gitVersion ?? t("git을 찾지 못함")}
              </div>
            )}
            {err && (
              <div className="ssh-error">
                <ErrorBox text={err} />
                <button className="btn sm" onClick={() => openPrefs("ssh")}>
                  <SlidersHorizontal size={12} />{" "}{t("이 호스트의 접속 주소·셸 설정")}</button>
              </div>
            )}
            <div className="ssh-list">
              {listing?.entries.map((e) => (
                <div
                  key={e.name}
                  className={"ssh-entry" + (e.isRepo ? " is-repo" : "")}
                  title={e.name}
                  onDoubleClick={() => (e.isRepo && mode === "open" ? onPick(host, join(listing.path, e.name), true) : go(host, join(listing.path, e.name)))}
                >
                  {e.isRepo ? <FolderGit2 size={15} className="accent" /> : <Folder size={15} />}
                  <MidEllipsis className="flex1" text={e.name} />
                  {e.isRepo && mode === "open" && (
                    <button className="btn xs" onClick={() => onPick(host, join(listing.path, e.name), true)}>{t("열기")}</button>
                  )}
                </div>
              ))}
              {listing && listing.entries.length === 0 && <p className="sb-empty">{t("하위 폴더가 없습니다.")}</p>}
            </div>
            {listing && (
              <div className="ssh-actions">
                <span className="mono tiny ellipsis flex1">{listing.path}</span>
                {mode === "open" ? (
                  <button className="btn primary" disabled={!listing.isRepo} onClick={() => onPick(host, listing.path, true)} title={listing.isRepo ? "" : t("Git 저장소 폴더가 아닙니다")}>{t("이 저장소 열기")}</button>
                ) : (
                  <button className="btn primary" onClick={() => onPick(host, listing.path, listing.isRepo)}>{t("이 폴더 선택")}</button>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
