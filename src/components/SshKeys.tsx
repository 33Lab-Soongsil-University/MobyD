// SSH key views: public keys in ~/.ssh on this Mac or an SSH host, the
// account's own keys on its service, and a repository's deploy keys. Keys are
// matched by their public part, so each list says where else a key is used.
import { useEffect, useState } from "react";
import { Copy, KeyRound, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { api, errorText } from "../lib/api";
import { copyText } from "../lib/actions";
import { basename, isoRelative } from "../lib/format";
import type { Account, RegisteredKey, SshKey } from "../lib/types";
import { t } from "../lib/i18n";
import { ErrorBox } from "./ErrorBox";

/** Public key → "service account" for every connected account (errors ignored). */
let accountIndex: Promise<Map<string, string>> | null = null;
function loadAccountIndex(fresh = false): Promise<Map<string, string>> {
  if (accountIndex && !fresh) return accountIndex;
  accountIndex = api
    .accounts()
    .then(async (accounts) => {
      const map = new Map<string, string>();
      await Promise.all(
        accounts
          .filter((a) => a.hasToken)
          .map((a) =>
            api
              .accountSshKeys(a.id)
              .then((keys) => keys.forEach((k) => map.set(k.key, `${a.label || a.kind} · ${a.username ?? ""}`)))
              .catch(() => {}),
          ),
      );
      return map;
    })
    .catch(() => new Map());
  return accountIndex;
}

/** The repository a MobyD-made key was made for (from its comment "mobyd owner/repo on host"). */
function mobydRepo(k: SshKey): string | null {
  if (!basename(k.path).startsWith("mobyd_")) return null;
  const m = k.comment.match(/^mobyd (\S+)/);
  return m ? m[1] : "";
}

function shortFp(fp: string) {
  return fp.length > 24 ? `${fp.slice(0, 19)}…${fp.slice(-4)}` : fp;
}

/** Public keys in ~/.ssh on this Mac (`host` null) or on an SSH host. */
export function SshKeyList({ host }: { host: string | null }) {
  const [keys, setKeys] = useState<SshKey[] | null>(null);
  const [owners, setOwners] = useState<Map<string, string>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    let live = true;
    setErr(null);
    api
      .sshKeys(host)
      .then((k) => live && setKeys(k))
      .catch((e) => live && setErr(errorText(e)));
    loadAccountIndex(seq > 0).then((m) => live && setOwners(m));
    return () => {
      live = false;
    };
  }, [host, seq]);

  return (
    <div className="key-block">
      <div className="key-head">
        <span>{host ? t("이 호스트의 SSH 키") : t("이 Mac의 SSH 키")}</span>
        <button className="icon-btn" title={t("새로 고침")} onClick={() => setSeq((n) => n + 1)}>
          <RefreshCw size={12} />
        </button>
      </div>
      {err && <ErrorBox text={err} />}
      {!err && !keys && <Loader2 size={14} className="spin muted" />}
      {keys && keys.length === 0 && <p className="muted tiny">{t("~/.ssh에 공개 키(.pub)가 없습니다.")}</p>}
      {keys && keys.length > 0 && (
        <ul className="key-list">
          {keys.map((k) => {
            const repo = mobydRepo(k);
            const owner = owners.get(k.publicKey);
            return (
              <li key={k.path} className="key-row" title={`${k.path}\n${k.fingerprint}`}>
                <KeyRound size={14} className="muted" />
                <div className="key-main">
                  <div className="ellipsis">
                    <strong>{basename(k.path).replace(/\.pub$/, "")}</strong>
                    <span className="muted tiny"> {k.kind}{k.kind === "RSA" ? ` ${k.bits}` : ""}</span>
                    {repo !== null && <span className="badge">MobyD{repo ? ` · ${repo}` : ""}</span>}
                    {owner && <span className="badge ok">{owner}</span>}
                    {k.inAgent && <span className="badge">ssh-agent</span>}
                  </div>
                  <div className="muted tiny mono ellipsis">
                    {shortFp(k.fingerprint)}
                    {k.comment && repo === null ? ` · ${k.comment}` : ""}
                  </div>
                </div>
                <button className="icon-btn" title={t("공개 키 복사")} onClick={() => copyText(k.publicKey, t("공개 키를 복사했습니다"))}>
                  <Copy size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The account's own SSH keys on its service. */
export function AccountKeys({ account, onReconnect }: { account: Account; onReconnect: () => void }) {
  const [keys, setKeys] = useState<RegisteredKey[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .accountSshKeys(account.id)
      .then((k) => live && setKeys(k))
      .catch((e) => live && setErr(errorText(e)));
    return () => {
      live = false;
    };
  }, [account.id]);
  if (err)
    return (
      <div className="key-block">
        <p className="muted tiny">{err}</p>
        <button className="btn sm" onClick={onReconnect}>
          {t("다시 연결")}
        </button>
      </div>
    );
  if (!keys) return <Loader2 size={14} className="spin muted" />;
  return (
    <div className="key-block">
      {keys.length === 0 && <p className="muted tiny">{t("이 계정에 등록된 SSH 키가 없습니다.")}</p>}
      <ul className="key-list">
        {keys.map((k) => (
          <li key={k.id} className="key-row">
            <KeyRound size={14} className="muted" />
            <div className="key-main">
              <div className="ellipsis">
                <strong>{k.title || k.key.split(" ")[0]}</strong>
              </div>
              <div className="muted tiny ellipsis">
                {k.key.split(" ")[0]}
                {k.createdAt ? ` · ${t("추가됨")} ${isoRelative(k.createdAt)}` : ""}
                {k.lastUsed ? ` · ${t("마지막 사용")} ${isoRelative(k.lastUsed)}` : ""}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Deploy keys of the repository behind `remote`, marked when the key is on the PC that holds the repository. */
export function DeployKeys({ repo, remote }: { repo: string; remote: string }) {
  const host = repo.startsWith("ssh://") ? repo.slice("ssh://".length).split("/")[0] : null;
  const [keys, setKeys] = useState<RegisteredKey[] | null>(null);
  const [local, setLocal] = useState<Map<string, string>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = () =>
    api
      .deployKeys(repo, remote)
      .then(setKeys)
      .catch((e) => setErr(errorText(e)));
  useEffect(() => {
    load();
    api
      .sshKeys(host)
      .then((list) => setLocal(new Map(list.map((k) => [k.publicKey, basename(k.path).replace(/\.pub$/, "")]))))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, remote]);

  if (err) return <ErrorBox text={err} />;
  if (!keys) return <Loader2 size={14} className="spin muted" />;
  const where = host ?? t("이 Mac");
  return (
    <div className="key-block">
      {keys.length === 0 && <p className="muted tiny">{t("등록된 배포 키가 없습니다.")}</p>}
      <ul className="key-list">
        {keys.map((k) => {
          const mine = local.get(k.key);
          return (
            <li key={k.id} className="key-row">
              <KeyRound size={14} className="muted" />
              <div className="key-main">
                <div className="ellipsis">
                  <strong>{k.title || t("(제목 없음)")}</strong>
                  <span className={"badge" + (k.canWrite ? " warn" : "")}>{k.canWrite ? t("쓰기") : t("읽기 전용")}</span>
                  {mine && <span className="badge ok">{t("{where}의 {name}", { where, name: mine })}</span>}
                </div>
                <div className="muted tiny ellipsis">
                  {k.key.split(" ")[0]}
                  {k.createdAt ? ` · ${t("추가됨")} ${isoRelative(k.createdAt)}` : ""}
                  {k.lastUsed ? ` · ${t("마지막 사용")} ${isoRelative(k.lastUsed)}` : ""}
                </div>
              </div>
              {confirming === k.id ? (
                <button
                  className="btn sm danger"
                  disabled={busy === k.id}
                  onClick={async () => {
                    setBusy(k.id);
                    try {
                      await api.deleteDeployKey(repo, remote, k.id);
                      setKeys((list) => list?.filter((x) => x.id !== k.id) ?? null);
                    } catch (e) {
                      setErr(errorText(e));
                    } finally {
                      setBusy(null);
                      setConfirming(null);
                    }
                  }}
                >
                  {busy === k.id ? <Loader2 size={12} className="spin" /> : t("삭제 확인")}
                </button>
              ) : (
                <button className="icon-btn" title={t("배포 키 삭제")} onClick={() => setConfirming(k.id)}>
                  <Trash2 size={13} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
