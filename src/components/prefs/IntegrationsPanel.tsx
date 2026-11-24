import { useEffect, useState } from "react";
import { UserPlus } from "lucide-react";
import { api, errorText } from "../../lib/api";
import type { Account } from "../../lib/types";
import { openManager, toast, useUi } from "../../store";
import { AccountRow, ConnectService, SERVICES, ServiceList, accountsFor, type ServiceId } from "../Integrations";
import { t } from "../../lib/i18n";

/** GitKraken-style Integrations: services on the left, the account (or a connect card) on the right. */
export function IntegrationsPanel() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selected, setSelected] = useState<ServiceId>(() => useUi.getState().integrationService ?? "github");
  const [adding, setAdding] = useState(false);
  const version = useUi((s) => s.accountsVersion);

  useEffect(() => {
    api.accounts().then(setAccounts).catch((e) => toast.error(t("계정 목록을 불러오지 못했습니다"), errorText(e)));
  }, [version]);

  const service = SERVICES.find((s) => s.id === selected) ?? SERVICES[0];
  const mine = accountsFor(service, accounts);

  return (
    <div className="prefs-pane integrations">
      <ServiceList
        accounts={accounts}
        selected={selected}
        onSelect={(id) => {
          setSelected(id as ServiceId);
          setAdding(false);
        }}
      />
      <div className="service-detail">
        {mine.length > 0 && (
          <div className="account-list">
            {mine.map((a) => (
              <AccountRow
                key={a.id}
                account={a}
                onRemoved={setAccounts}
                onBrowse={() => {
                  useUi.getState().setModal(null);
                  openManager("clone", a.id);
                }}
                onReconnect={() => setAdding(true)}
              />
            ))}
          </div>
        )}
        {mine.length === 0 || adding ? (
          <ConnectService
            service={service}
            onConnected={(list) => {
              setAccounts(list);
              setAdding(false);
            }}
          />
        ) : (
          <button className="btn ghost add-account" onClick={() => setAdding(true)}>
            <UserPlus size={14} /> {t("다른 계정 추가")}
          </button>
        )}
      </div>
    </div>
  );
}
