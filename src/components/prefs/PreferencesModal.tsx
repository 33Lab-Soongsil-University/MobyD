import { useEffect, useState } from "react";
import { ZoomIn, ZoomOut, X, Settings2, Palette, PlugZap, Server, Monitor, Moon, Sun, FolderSearch, Loader2, CheckCircle2, XCircle, SlidersHorizontal } from "lucide-react";
import { api, errorText } from "../../lib/api";
import type { AppInfo, HostPrefs, ShellPref, SshHost, TailscalePeer } from "../../lib/types";
import { applyTheme, getThemePref, type ThemePref } from "../../lib/theme";
import { getCloneDir, pickDirectory, setCloneDir } from "../../lib/actions";
import { useUi, type PrefsTab } from "../../store";
import { IntegrationsPanel } from "./IntegrationsPanel";
import { LANG_NAMES, getLangPref, setLangPref, t, type LangPref } from "../../lib/i18n";
import { tj } from "../../lib/i18n-react";
import { ErrorBox } from "../ErrorBox";
import { useEscape } from "../../lib/escape";
import { ZOOM_STEPS, getZoom, resetZoom, zoomIn, zoomOut } from "../../lib/zoom";

const TABS: { id: PrefsTab; label: string; icon: React.ReactNode }[] = [
  { id: "general", label: t("일반"), icon: <Settings2 size={15} /> },
  { id: "appearance", label: t("외관"), icon: <Palette size={15} /> },
  { id: "integrations", label: t("통합 (계정)"), icon: <PlugZap size={15} /> },
  { id: "ssh", label: t("SSH 원격"), icon: <Server size={15} /> },
];

function General() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const langPref = getLangPref();
  const [dir, setDir] = useState(getCloneDir());
  useEffect(() => {
    api.appInfo().then(setInfo).catch(() => {});
  }, []);
  return (
    <div className="prefs-pane">
      <label className="field">
        <span>{t("기본 복제 위치")}</span>
        <div className="input-row">
          <input className="mono" value={dir} placeholder={t("처음 복제할 때 묻습니다")} onChange={(e) => {
            setDir(e.target.value);
            setCloneDir(e.target.value);
          }} spellCheck={false} />
          <button className="btn" onClick={async () => {
            const d = await pickDirectory(t("기본 복제 위치"));
            if (d) {
              setDir(d);
              setCloneDir(d);
            }
          }}>
            <FolderSearch size={14} />
          </button>
        </div>
        <small className="muted">{t("통합 계정의 저장소를 한 번에 복제할 때 이 폴더 아래에 만듭니다.")}</small>
      </label>
      <div className="field">
        <span>{t("언어")}</span>
        <div className="seg wide">
          {(["system", "ko", "en"] as LangPref[]).map((l) => (
            <button key={l} className={langPref === l ? "on" : ""} onClick={() => setLangPref(l)}>
              {l === "system" ? t("시스템 설정 따르기") : LANG_NAMES[l]}
            </button>
          ))}
        </div>
        <small className="muted">{t("바꾸면 화면을 다시 불러옵니다. 열린 탭은 그대로 유지됩니다.")}</small>
      </div>
      <div className="kv">
        <span>Git</span>
        <span className="mono">{info?.gitVersion ?? t("찾을 수 없음")}</span>
        <span>{t("Git 경로")}</span>
        <span className="mono">{info?.gitPath}</span>
        <span>MobyD</span>
        <span className="mono">{info?.version}</span>
      </div>
    </div>
  );
}

function Appearance() {
  const [pref, setPref] = useState<ThemePref>(getThemePref());
  const choose = (p: ThemePref) => {
    setPref(p);
    applyTheme(p);
  };
  const options: { id: ThemePref; label: string; hint: string; icon: React.ReactNode }[] = [
    { id: "system", label: t("시스템 설정 따르기"), hint: t("macOS·Windows의 라이트/다크 전환을 실시간으로 따라갑니다"), icon: <Monitor size={18} /> },
    { id: "dark", label: t("다크 (심해)"), hint: t("깊은 바다 색"), icon: <Moon size={18} /> },
    { id: "light", label: t("라이트 (얕은 바다)"), hint: t("밝은 물빛"), icon: <Sun size={18} /> },
  ];
  return (
    <div className="prefs-pane">
      <div className="theme-cards">
        {options.map((o) => (
          <button key={o.id} className={"theme-card" + (pref === o.id ? " on" : "")} onClick={() => choose(o.id)}>
            <span className={`theme-swatch ${o.id}`}>{o.icon}</span>
            <strong>{o.label}</strong>
            <small className="muted">{o.hint}</small>
          </button>
        ))}
      </div>
      <ZoomControl />
    </div>
  );
}

function ZoomControl() {
  const [zoom, setZoomState] = useState(getZoom());
  useEffect(() => {
    const on = (e: Event) => setZoomState((e as CustomEvent<number>).detail);
    window.addEventListener("mobyd-zoom", on);
    return () => window.removeEventListener("mobyd-zoom", on);
  }, []);
  return (
    <div className="field">
      <span>{t("화면 크기")}</span>
      <div className="zoom-control">
        <button className="btn" onClick={() => zoomOut()} disabled={zoom <= ZOOM_STEPS[0]} title="⌘−">
          <ZoomOut size={14} />
        </button>
        <strong className="zoom-value">{Math.round(zoom * 100)}%</strong>
        <button className="btn" onClick={() => zoomIn()} disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} title="⌘+">
          <ZoomIn size={14} />
        </button>
        <button className="btn ghost" onClick={() => resetZoom()} disabled={zoom === 1} title="⌘0">
          {t("기본 크기")}
        </button>
      </div>
      <small className="muted">{t("어디서든 ⌘+ 로 키우고 ⌘− 로 줄이며, ⌘0 으로 기본 크기로 돌아갑니다.")}</small>
    </div>
  );
}

const SHELL_OPTIONS: { id: ShellPref; label: string; hint: string }[] = [
  { id: "auto", label: t("자동 감지"), hint: t("기본 셸을 확인하고 명령을 한 번 실제로 실행해 검증한 뒤, 안 되면 다른 방식으로 넘어갑니다.") },
  { id: "posix", label: "POSIX", hint: t("macOS·Linux 또는 기본 셸이 Git Bash인 Windows.") },
  { id: "cmd", label: "Windows cmd", hint: t("기본 셸이 cmd.exe인 Windows. Git for Windows의 bash로 실행합니다.") },
  { id: "powershell", label: "PowerShell", hint: t("기본 셸이 PowerShell인 Windows. Git for Windows의 bash로 실행합니다.") },
];

const DEFAULT_PREFS: HostPrefs = { shell: "auto", address: null };

/** A Tailscale peer that looks like this ssh host (same machine name). */
function matchPeer(h: SshHost, peers: TailscalePeer[]): TailscalePeer | null {
  const names = [h.alias, ...h.otherAliases, h.hostname ?? ""].map((n) => n.toLowerCase().split(".")[0]).filter(Boolean);
  return peers.find((p) => names.includes(p.name.toLowerCase())) ?? null;
}

/** The config already reaches this peer over Tailscale (by IP or MagicDNS name). */
function viaPeer(h: SshHost, p: TailscalePeer): boolean {
  const target = (h.hostname ?? h.alias).toLowerCase().replace(/\.$/, "");
  return target === p.address || (p.dns !== null && target === p.dns.toLowerCase());
}

function HostSettings({
  host,
  prefs,
  peers,
  onSave,
}: {
  host: SshHost;
  prefs: HostPrefs;
  peers: TailscalePeer[];
  onSave: (p: HostPrefs) => Promise<void>;
}) {
  const [shell, setShell] = useState<ShellPref>(prefs.shell);
  const [address, setAddress] = useState(prefs.address ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = shell !== prefs.shell || (address.trim() || null) !== prefs.address;
  const save = async (next: HostPrefs) => {
    setBusy(true);
    setErr(null);
    try {
      await onSave(next);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ssh-host-prefs">
      <div className="field">
        <span>{t("명령 실행 방식")}</span>
        <div className="seg wide">
          {SHELL_OPTIONS.map((o) => (
            <button key={o.id} className={shell === o.id ? "on" : ""} onClick={() => setShell(o.id)} title={o.hint}>
              {o.label}
            </button>
          ))}
        </div>
        <small className="muted">{SHELL_OPTIONS.find((o) => o.id === shell)?.hint}{" "}{t("호스트의 기본 셸 설정은 바꾸지 않습니다.")}</small>
      </div>
      <label className="field">
        <span>{t("MobyD 전용 주소")}</span>
        <div className="input-row">
          <input
            className="mono"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={host.hostname ?? host.alias}
            spellCheck={false}
          />
          {peers.length > 0 && (
            <select
              value=""
              onChange={(e) => e.target.value && setAddress(e.target.value)}
              title={t("Tailscale 기기에서 고르기")}
            >
              <option value="">{t("Tailscale 기기…")}</option>
              {peers.map((p) => (
                <option key={p.address} value={p.address}>
                  {p.name} · {p.address}
                  {p.online ? "" : t(" (오프라인)")}
                </option>
              ))}
            </select>
          )}
        </div>
        <small className="muted">{tj("비워 두면 {config}의 주소를 씁니다. 값을 넣으면 MobyD만 이 주소로 접속하고, 사용자·키·포트는 config 설정을 그대로 씁니다.", {
            config: <code>~/.ssh/config</code>,
          })}
        </small>
      </label>
      {err && <ErrorBox text={err} />}
      <div className="dialog-actions">
        <button
          className="btn"
          disabled={busy || (prefs.shell === "auto" && !prefs.address && !dirty)}
          onClick={() => {
            setShell("auto");
            setAddress("");
            save(DEFAULT_PREFS);
          }}
        >{t("기본값으로")}</button>
        <button className="btn primary" disabled={busy || !dirty} onClick={() => save({ shell, address: address.trim() || null })}>
          {busy ? <Loader2 size={12} className="spin" /> : null}{" "}{t("저장하고 연결 확인")}</button>
      </div>
    </div>
  );
}

function SshPane() {
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [prefs, setPrefs] = useState<Record<string, HostPrefs>>({});
  const [peers, setPeers] = useState<TailscalePeer[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [probe, setProbe] = useState<Record<string, { state: "busy" | "ok" | "err"; text: string }>>({});
  useEffect(() => {
    api.sshHosts().then(setHosts).catch(() => {});
    api.sshHostPrefs().then(setPrefs).catch(() => {});
    api.sshTailscalePeers().then(setPeers).catch(() => {});
  }, []);
  const test = async (alias: string) => {
    setProbe((p) => ({ ...p, [alias]: { state: "busy", text: "" } }));
    const t0 = performance.now();
    try {
      const l = await api.sshListDir(alias, null);
      const ms = Math.round(performance.now() - t0);
      setProbe((p) => ({
        ...p,
        [alias]: { state: "ok", text: `${l.os || "?"} · ${l.shell} · ${l.gitVersion ?? t("git 없음")} · ${ms}ms` },
      }));
    } catch (e) {
      setProbe((p) => ({ ...p, [alias]: { state: "err", text: errorText(e) } }));
    }
  };
  const savePrefs = async (alias: string, next: HostPrefs) => {
    setPrefs(await api.sshSetHostPrefs(alias, next));
    await test(alias);
  };
  return (
    <div className="prefs-pane">
      <p className="muted tiny">
        {tj(
          "{config}의 호스트를 그대로 씁니다(키·에이전트·포트·점프 호스트 포함). MobyD는 호스트마다 연결 하나를 유지해 재사용하고 (ControlMaster), 새로고침에 필요한 git 명령을 원격에서 한 번에 묶어 실행합니다. 비밀번호 인증은 지원하지 않으니 키 인증을 설정하세요. Windows 호스트는 기본 셸이 cmd·PowerShell·Git Bash 무엇이든 Git for Windows만 있으면 됩니다.",
          { config: <code>~/.ssh/config</code> },
        )}
      </p>
      <div className="account-list">
        {hosts.length === 0 && <p className="muted">{t("~/.ssh/config에 Host 항목이 없습니다.")}</p>}
        {hosts.map((h) => {
          const pr = probe[h.alias];
          const hp = prefs[h.alias] ?? DEFAULT_PREFS;
          const peer = matchPeer(h, peers);
          const suggest = peer && !hp.address && !viaPeer(h, peer) ? peer : null;
          return (
            <div key={h.alias} className="ssh-host-card">
              <div className="account">
                <Server size={18} />
                <div className="flex1">
                  <strong>{h.alias}</strong>
                  {hp.shell !== "auto" && <span className="chip host">{SHELL_OPTIONS.find((o) => o.id === hp.shell)?.label}</span>}
                  <div className="muted tiny mono">
                    {h.user ? `${h.user}@` : ""}
                    {hp.address ? (
                      <>
                        <s>{h.hostname ?? h.alias}</s> → {hp.address} <span className="sans">{t("(MobyD 전용)")}</span>
                      </>
                    ) : (
                      h.hostname ?? h.alias
                    )}
                    {h.port ? `:${h.port}` : ""}
                  </div>
                  {pr && pr.state !== "busy" && (
                    <div className={"tiny " + (pr.state === "ok" ? "green" : "red")}>
                      {pr.state === "ok" ? <CheckCircle2 size={11} /> : <XCircle size={11} />} {pr.text}
                    </div>
                  )}
                  {suggest && (pr?.state === "err" || open === h.alias) && (
                    <div className="tiny">{t("Tailscale에 같은 이름의 기기가 있습니다:")}{" "}<span className="mono">{suggest.name} · {suggest.address}</span>
                      {suggest.online ? "" : t(" (오프라인)")}{" "}
                      <button className="btn xs" onClick={() => savePrefs(h.alias, { ...hp, address: suggest.address })}>{t("이 주소로 접속")}</button>
                    </div>
                  )}
                </div>
                <button className="icon-btn" title={t("이 호스트 설정")} aria-expanded={open === h.alias} onClick={() => setOpen(open === h.alias ? null : h.alias)}>
                  <SlidersHorizontal size={14} />
                </button>
                <button className="btn sm" onClick={() => test(h.alias)} disabled={pr?.state === "busy"}>
                  {pr?.state === "busy" ? <Loader2 size={12} className="spin" /> : null}{" "}{t("연결 확인")}</button>
              </div>
              {open === h.alias && (
                <HostSettings key={JSON.stringify(hp)} host={h} prefs={hp} peers={peers} onSave={(next) => savePrefs(h.alias, next)} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PreferencesModal() {
  const tab = useUi((s) => s.prefsTab);
  const close = () => useUi.getState().setModal(null);
  useEscape(close);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog prefs" role="dialog" aria-label={t("환경설정")}>
        <nav className="prefs-nav">
          <h3>{t("환경설정")}</h3>
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => useUi.setState({ prefsTab: t.id })}>
              {t.icon} {t.label}
            </button>
          ))}
        </nav>
        <section className="prefs-body">
          <div className="dialog-title-row">
            <h3>{TABS.find((t) => t.id === tab)?.label}</h3>
            <button className="icon-btn" onClick={close} aria-label={t("닫기")}>
              <X size={16} />
            </button>
          </div>
          {tab === "general" && <General />}
          {tab === "appearance" && <Appearance />}
          {tab === "integrations" && <IntegrationsPanel />}
          {tab === "ssh" && <SshPane />}
        </section>
      </div>
    </div>
  );
}
