// Shared pieces of the GitKraken-style integrations: the service catalogue,
// the "connect" card (browser sign-in with a device code, token, GitHub CLI)
// and the list of signed-in accounts. Used by Preferences → Integrations and
// by the Clone screen of the repository manager.
import { useEffect, useRef, useState } from "react";
import {
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  Loader2,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorText } from "../lib/api";
import type { Account, DeviceStart, ForgeKind } from "../lib/types";
import { confirmAction, toast, useUi } from "../store";
import { ForgeIcon } from "./ForgeIcon";
import { AccountKeys } from "./SshKeys";
import { t } from "../lib/i18n";

export type ServiceId = "github" | "ghe" | "gitlab" | "gitlab-self" | "gitea";

export interface Service {
  id: ServiceId;
  kind: ForgeKind;
  label: string;
  /** Fixed server (github.com, gitlab.com); empty means the user types it. */
  base: string;
  placeholder?: string;
}

export const SERVICES: Service[] = [
  {
    id: "github",
    kind: "github",
    label: "GitHub.com",
    base: "https://github.com",
  },
  {
    id: "ghe",
    kind: "github",
    label: "GitHub Enterprise",
    base: "",
    placeholder: "https://github.example.com",
  },
  {
    id: "gitlab",
    kind: "gitlab",
    label: "GitLab.com",
    base: "https://gitlab.com",
  },
  {
    id: "gitlab-self",
    kind: "gitlab",
    label: "GitLab Self-Managed",
    base: "",
    placeholder: "https://gitlab.example.com",
  },
  {
    id: "gitea",
    kind: "gitea",
    label: "Gitea · Forgejo",
    base: "",
    placeholder: "https://gitea.example.com",
  },
];

const PUBLIC_HOSTS = ["github.com", "gitlab.com"];

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url
      .replace(/^\w+:\/\//, "")
      .split("/")[0]
      .toLowerCase();
  }
}

export function accountsFor(service: Service, accounts: Account[]): Account[] {
  return accounts.filter((a) => {
    if (a.kind !== service.kind) return false;
    if (service.base) return hostOf(a.baseUrl) === hostOf(service.base);
    return (
      service.kind === "gitea" || !PUBLIC_HOSTS.includes(hostOf(a.baseUrl))
    );
  });
}

export function serviceOf(a: Account): Service {
  return SERVICES.find((s) => accountsFor(s, [a]).length > 0) ?? SERVICES[0];
}

/** Where to create a token with the right scopes already ticked. */
function tokenUrl(kind: ForgeKind, base: string) {
  const b = base.replace(/\/+$/, "");
  if (kind === "github")
    return `${b}/settings/tokens/new?scopes=repo,read:user,read:org,workflow&description=MobyD`;
  if (kind === "gitlab")
    return `${b}/-/user_settings/personal_access_tokens?name=MobyD&scopes=api,read_user`;
  return `${b}/user/settings/applications`;
}

function scopesHint(kind: ForgeKind) {
  if (kind === "github")
    return t(
      "repo, read:user, read:org, workflow (fine-grained 토큰이면 Contents · Pull requests · Metadata 읽기/쓰기)",
    );
  if (kind === "gitlab") return "api, read_user";
  return t("repository · issue · organization 읽기/쓰기, user 읽기");
}

/** The account management page for the built-in GitHub OAuth app (organisation access grants). */
const GITHUB_APP_CONNECTIONS =
  "https://github.com/settings/connections/applications/Ov23lieIItaI2GuawY0B";

function DeviceCode({
  flow,
  label,
  onCancel,
}: {
  flow: DeviceStart;
  label: string;
  onCancel: () => void;
}) {
  const open = () =>
    openUrl(flow.verificationUriComplete ?? flow.verificationUri).catch(
      () => {},
    );
  return (
    <div className="device-box" role="status">
      <p>
        {t(
          "브라우저에서 {service}에 로그인한 뒤 아래 코드를 입력하고 MobyD를 승인하세요.",
          { service: label },
        )}
      </p>
      <div className="device-code">
        <code>{flow.userCode}</code>
        <button
          className="icon-btn"
          title={t("코드 복사")}
          onClick={() =>
            navigator.clipboard
              ?.writeText(flow.userCode)
              .then(() => toast.success(t("코드를 복사했습니다")))
          }
        >
          <Copy size={14} />
        </button>
      </div>
      <p className="muted tiny">
        <Loader2 size={12} className="spin" />{" "}
        {t("승인을 기다리는 중… 코드는 클립보드에 복사해 두었습니다.")}
      </p>
      <div className="dialog-actions">
        <button className="btn" onClick={onCancel}>
          <X size={13} /> {t("취소")}
        </button>
        <button className="btn" onClick={open}>
          <ExternalLink size={13} /> {t("로그인 페이지 다시 열기")}
        </button>
      </div>
    </div>
  );
}

/**
 * GitKraken-style "Connect to <service>": a browser sign-in button first,
 * then a token form (pre-filled scopes) and the GitHub CLI import.
 */
export function ConnectService({
  service,
  onConnected,
}: {
  service: Service;
  onConnected: (a: Account[]) => void;
}) {
  const [base, setBase] = useState(service.base);
  const [oauth, setOauth] = useState<boolean | null>(null);
  const [gh, setGh] = useState(false);
  const [flow, setFlow] = useState<DeviceStart | null>(null);
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [token, setToken] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const cancelled = useRef(false);
  const bump = useUi((s) => s.bumpAccounts);

  useEffect(() => {
    setBase(service.base);
    setFlow(null);
    setShowToken(false);
  }, [service.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true;
    if (!base.trim()) {
      setOauth(false);
      return;
    }
    setOauth(null);
    api
      .oauthAvailable(service.kind, base)
      .then((v) => live && setOauth(v))
      .catch(() => live && setOauth(false));
    return () => {
      live = false;
    };
  }, [service.kind, base]);

  useEffect(() => {
    if (service.kind === "github" && service.id === "github")
      api
        .ghCliAvailable()
        .then(setGh)
        .catch(() => setGh(false));
    else setGh(false);
  }, [service.id, service.kind]);

  // Without browser sign-in the token form is the main path, so show it open.
  useEffect(() => {
    if (oauth === false) setShowToken(true);
  }, [oauth]);

  const done = (accounts: Account[]) => {
    bump();
    onConnected(accounts);
  };

  const signIn = async () => {
    setBusy(true);
    cancelled.current = false;
    try {
      const f = await api.oauthDeviceStart(service.kind, base);
      setFlow(f);
      navigator.clipboard?.writeText(f.userCode).catch(() => {});
      await openUrl(f.verificationUriComplete ?? f.verificationUri).catch(
        () => {},
      );
      let wait = f.interval;
      const until = Date.now() + f.expiresIn * 1000;
      while (!cancelled.current && Date.now() < until) {
        await new Promise((r) => setTimeout(r, wait * 1000));
        if (cancelled.current) break;
        const p = await api.oauthDevicePoll(f.flowId);
        if (p.status === "done" && p.accounts) {
          const me = p.accounts.find(
            (a) =>
              a.kind === service.kind && hostOf(a.baseUrl) === hostOf(base),
          );
          toast.success(
            t("{service}에 연결했습니다", { service: service.label }),
            me?.username ?? undefined,
          );
          done(p.accounts);
          return;
        }
        if (p.status === "denied") {
          toast.error(t("로그인을 거부했습니다"));
          return;
        }
        if (p.status === "expired") {
          toast.error(t("로그인 코드가 만료되었습니다. 다시 시도하세요."));
          return;
        }
        wait = Math.max(p.interval, 1);
      }
    } catch (e) {
      toast.error(t("브라우저 로그인에 실패했습니다"), errorText(e));
    } finally {
      setFlow(null);
      setBusy(false);
    }
  };

  const cancel = () => {
    cancelled.current = true;
    if (flow) api.oauthDeviceCancel(flow.flowId).catch(() => {});
    setFlow(null);
    setBusy(false);
  };

  const connectToken = async () => {
    setBusy(true);
    try {
      const list = await api.addAccount(
        service.kind,
        base,
        token,
        apiUrl.trim() || null,
      );
      setToken("");
      toast.success(t("{service}에 연결했습니다", { service: service.label }));
      done(list);
    } catch (e) {
      toast.error(t("로그인하지 못했습니다"), errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const importGh = async () => {
    setBusy(true);
    try {
      const list = await api.importGh();
      toast.success(t("GitHub CLI 로그인으로 연결했습니다"));
      done(list);
    } catch (e) {
      toast.error(t("GitHub CLI에서 가져오지 못했습니다"), errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connect-card">
      <div className="connect-head">
        <span className="connect-logo">
          <ForgeIcon kind={service.kind} size={34} />
        </span>
        <div>
          <h3>{t("{service}에 연결", { service: service.label })}</h3>
          <p className="muted tiny">
            {t(
              "연결하면 이 계정으로 접근할 수 있는 모든 저장소를 목록에서 골라 바로 복제하고, PR을 보고 병합할 수 있습니다. HTTPS 원격의 fetch·pull·push에도 이 계정이 쓰입니다.",
            )}
          </p>
        </div>
      </div>

      {!service.base && (
        <label className="field">
          <span>{t("서버 주소")}</span>
          <input
            className="mono"
            value={base}
            placeholder={service.placeholder}
            onChange={(e) => setBase(e.target.value)}
            spellCheck={false}
          />
          <small className="muted">
            {service.kind === "github"
              ? t("GitHub Enterprise Server 주소 (API는 /api/v3).")
              : service.kind === "gitlab"
                ? t("자체 운영 GitLab 주소 (API는 /api/v4).")
                : t(
                    "Gitea · Forgejo · Codeberg 주소 (API는 /api/v1). 로컬 서버면 http://localhost:3000 처럼 입력하세요.",
                  )}
          </small>
        </label>
      )}

      {flow ? (
        <DeviceCode flow={flow} label={service.label} onCancel={cancel} />
      ) : (
        <div className="connect-actions">
          {oauth && (
            <button
              className="btn primary big"
              disabled={busy || !base.trim()}
              onClick={signIn}
            >
              {busy ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Globe size={15} />
              )}{" "}
              {t("브라우저로 {service} 로그인", { service: service.label })}
            </button>
          )}
          {gh && (
            <button
              className="btn"
              disabled={busy}
              onClick={importGh}
              title={t("gh auth token 으로 이미 로그인된 토큰을 사용합니다")}
            >
              <Terminal size={13} /> {t("GitHub CLI 로그인 가져오기")}
            </button>
          )}
          {oauth && (
            <button
              className="btn ghost"
              onClick={() => setShowToken(!showToken)}
              aria-expanded={showToken}
            >
              <KeyRound size={13} /> {t("개인 액세스 토큰으로 연결")}
            </button>
          )}
        </div>
      )}

      {!flow && (showToken || oauth === false) && (
        <div className="token-form">
          <label className="field">
            <span>{t("개인 액세스 토큰")}</span>
            <div className="input-row">
              <input
                type="password"
                className="mono"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="btn"
                disabled={!base.trim()}
                onClick={() =>
                  openUrl(tokenUrl(service.kind, base)).catch(() => {})
                }
              >
                <ExternalLink size={13} /> {t("토큰 만들기")}
              </button>
            </div>
            <small className="muted">
              {t("필요한 권한:")} {scopesHint(service.kind)}
            </small>
          </label>
          <details>
            <summary className="muted tiny">
              {t("고급: API 주소 직접 지정")}
            </summary>
            <label className="field">
              <span>{t("API 주소")}</span>
              <input
                className="mono"
                value={apiUrl}
                placeholder={t("비우면 자동")}
                onChange={(e) => setApiUrl(e.target.value)}
                spellCheck={false}
              />
            </label>
          </details>
          <div className="dialog-actions">
            <button
              className="btn primary"
              disabled={busy || !token.trim() || !base.trim()}
              onClick={connectToken}
            >
              {busy ? (
                <Loader2 size={13} className="spin" />
              ) : (
                <KeyRound size={13} />
              )}{" "}
              {t("토큰으로 연결")}
            </button>
          </div>
        </div>
      )}
      <p className="muted tiny">
        {t("토큰은 OS 키체인에 저장되고 화면으로는 다시 보내지 않습니다.")}
      </p>
    </div>
  );
}

/** One signed-in account: avatar, name, server and actions. */
export function AccountRow({
  account,
  onRemoved,
  onBrowse,
  onReconnect,
}: {
  account: Account;
  onRemoved: (a: Account[]) => void;
  onBrowse?: () => void;
  /** Sign in to the same account again (to grant new permissions). */
  onReconnect?: () => void;
}) {
  const bump = useUi((s) => s.bumpAccounts);
  const [keys, setKeys] = useState(false);
  const github =
    account.kind === "github" && hostOf(account.baseUrl) === "github.com";
  return (
    <>
    <div className="account">
      {account.avatarUrl ? (
        <img
          className="avatar img"
          src={account.avatarUrl}
          alt=""
          referrerPolicy="no-referrer"
        />
      ) : (
        <ForgeIcon kind={account.kind} size={26} />
      )}
      <div
        className="flex1"
        title={`${account.username ?? ""} · ${account.baseUrl}`}
      >
        <div>
          <strong>{account.username}</strong>{" "}
          <span className="muted">· {serviceOf(account).label}</span>
        </div>
        <div className="muted tiny mono">{account.baseUrl}</div>
      </div>
      <div className="account-actions">
        {account.hasToken ? (
          <span className="badge ok">
            <ShieldCheck size={11} /> {t("연결됨")}
          </span>
        ) : (
          <span className="badge warn">{t("토큰 없음")}</span>
        )}
        {github && (
          <button
            className="icon-btn"
            title={t("조직 접근 권한 관리 (GitHub)")}
            onClick={() => openUrl(GITHUB_APP_CONNECTIONS).catch(() => {})}
          >
            <ExternalLink size={14} />
          </button>
        )}
        {account.hasToken && (
          <button className={"icon-btn" + (keys ? " on" : "")} title={t("이 계정의 SSH 키")} onClick={() => setKeys((v) => !v)}>
            <KeyRound size={14} />
          </button>
        )}
        {onBrowse && (
          <button className="btn sm" onClick={onBrowse}>
            {t("저장소 복제")}
          </button>
        )}
        <button
          className="icon-btn"
          title={t("연결 해제")}
          onClick={async () => {
            if (
              !(await confirmAction(
                t("연결 해제"),
                t(
                  "{username} ({baseUrl}) 연결을 끊고 저장된 토큰을 지웁니다.",
                  { username: account.username, baseUrl: account.baseUrl },
                ),
                t("연결 해제"),
                true,
              ))
            )
              return;
            onRemoved(await api.removeAccount(account.id));
            bump();
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
    {keys && (
      <div className="account-keys">
        <AccountKeys account={account} onReconnect={() => onReconnect?.()} />
      </div>
    )}
    </>
  );
}

/** Left-hand service list (Preferences → Integrations and Clone). */
export function ServiceList({
  accounts,
  selected,
  onSelect,
  extra,
}: {
  accounts: Account[];
  selected: string;
  onSelect: (id: string) => void;
  extra?: React.ReactNode;
}) {
  return (
    <nav className="service-list">
      {extra}
      {SERVICES.map((s) => {
        const mine = accountsFor(s, accounts);
        return (
          <button
            key={s.id}
            className={selected === s.id ? "on" : ""}
            onClick={() => onSelect(s.id)}
          >
            <ForgeIcon kind={s.kind} size={16} />
            <span className="flex1 ellipsis">{s.label}</span>
            {mine.length > 0 ? (
              mine[0].avatarUrl ? (
                <img
                  className="avatar xs img"
                  src={mine[0].avatarUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  title={mine.map((a) => a.username).join(", ")}
                />
              ) : (
                <span className="dot ok" title={t("연결됨")} />
              )
            ) : (
              <span className="muted tiny">{t("연결")}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
