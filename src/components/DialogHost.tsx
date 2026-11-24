import { useEffect, useRef, useState } from "react";
import { FolderSearch } from "lucide-react";
import { useUi, type DialogField, type DialogValues } from "../store";
import { pickDirectory } from "../lib/actions";
import { useEscape } from "../lib/escape";
import { t } from "../lib/i18n";

function initial(fields: DialogField[] = []): DialogValues {
  const v: DialogValues = {};
  for (const f of fields) v[f.name] = f.value ?? (f.type === "checkbox" ? false : f.type === "select" ? f.options?.[0]?.value ?? "" : "");
  return v;
}

export function DialogHost() {
  const dialog = useUi((s) => s.dialog);
  const [values, setValues] = useState<DialogValues>({});
  const touched = useRef<Set<string>>(new Set());
  const firstInput = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (dialog) {
      touched.current = new Set();
      setValues(initial(dialog.fields));
      setTimeout(() => {
        const el = firstInput.current;
        if (el?.isConnected) {
          el.focus();
          if (el instanceof HTMLInputElement) el.select();
        } else {
          // Nothing to type: Enter confirms right away. A destructive question
          // starts on Cancel instead, so a stray Enter cannot delete anything.
          (dialog.danger ? cancelBtn : confirmBtn).current?.focus();
        }
      }, 30);
    }
  }, [dialog]);

  useEscape(() => dialog?.resolve(null), Boolean(dialog));

  if (!dialog) return null;
  const fields = dialog.fields ?? [];
  const visible = fields.filter((f) => !f.showWhen || f.showWhen.equals.includes(values[f.showWhen.field]));
  const missing = visible.some((f) => f.required && !String(values[f.name] ?? "").trim());

  const submit = () => {
    if (missing) return;
    dialog.resolve(values);
  };
  const cancel = () => dialog.resolve(null);
  let focusAssigned = false;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <form
        className={"dialog" + (dialog.wide ? " wide" : "")}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
      >
        <h3>{dialog.title}</h3>
        {dialog.message && <div className="dialog-message">{dialog.message}</div>}
        {visible.map((f) => {
          const ref = (el: HTMLInputElement | HTMLTextAreaElement | null) => {
            if (!focusAssigned && el && (f.type === undefined || f.type === "text" || f.type === "textarea" || f.type === "password")) {
              firstInput.current = el;
              focusAssigned = true;
            }
          };
          const set = (v: string | boolean) => {
            touched.current.add(f.name);
            setValues((prev) => {
              const next = { ...prev, [f.name]: v };
              for (const d of fields) if (d.derive && !touched.current.has(d.name)) next[d.name] = d.derive(next);
              return next;
            });
          };
          if (f.type === "checkbox") {
            return (
              <label key={f.name} className="check">
                <input type="checkbox" checked={Boolean(values[f.name])} onChange={(e) => set(e.target.checked)} />
                <span>{f.label}</span>
                {f.hint && <small className="muted">{f.hint}</small>}
              </label>
            );
          }
          return (
            <label key={f.name} className="field">
              <span>{f.label}</span>
              {f.type === "select" ? (
                <select value={String(values[f.name] ?? "")} onChange={(e) => set(e.target.value)}>
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.type === "textarea" ? (
                <textarea
                  ref={ref}
                  rows={6}
                  value={String(values[f.name] ?? "")}
                  placeholder={f.placeholder}
                  className={f.mono ? "mono" : ""}
                  onChange={(e) => set(e.target.value)}
                />
              ) : (
                <div className="input-row">
                  <input
                    ref={ref}
                    type={f.type === "password" ? "password" : "text"}
                    value={String(values[f.name] ?? "")}
                    placeholder={f.placeholder}
                    className={f.mono ? "mono" : ""}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => set(e.target.value)}
                  />
                  {f.browse === "directory" && (
                    <button
                      type="button"
                      className="btn"
                      onClick={async () => {
                        const d = await pickDirectory(f.label);
                        if (d) set(d);
                      }}
                    >
                      <FolderSearch size={14} />
                    </button>
                  )}
                </div>
              )}
              {f.hint && <small className="muted">{f.hint}</small>}
            </label>
          );
        })}
        <div className="dialog-actions">
          {!dialog.infoOnly && (
            <button type="button" className="btn" onClick={cancel} ref={cancelBtn}>
              {dialog.cancelLabel ?? t("취소")}
            </button>
          )}
          <button type="submit" className={"btn " + (dialog.danger ? "danger" : "primary")} disabled={missing} ref={confirmBtn}>
            {dialog.confirmLabel ?? t("확인")}
          </button>
        </div>
      </form>
    </div>
  );
}
