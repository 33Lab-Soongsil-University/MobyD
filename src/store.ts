import { create } from "zustand";
import type { ReactNode } from "react";
import type { RepoInfo } from "./lib/types";
import { t } from "./lib/i18n";

export type ToastKind = "info" | "success" | "error" | "warning";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  /** Kept on screen while the pointer is over it. */
  held?: boolean;
  /** A button on the toast; clicking it also closes the toast. */
  action?: { label: string; run: () => void };
  /** Stays until closed or acted on. */
  sticky?: boolean;
}

export interface FieldOption {
  value: string;
  label: string;
}

export interface DialogField {
  name: string;
  label: string;
  type?: "text" | "textarea" | "select" | "checkbox" | "password";
  value?: string | boolean;
  options?: FieldOption[];
  placeholder?: string;
  hint?: string;
  /** Show this field only when another field has one of these values. */
  showWhen?: { field: string; equals: (string | boolean)[] };
  required?: boolean;
  mono?: boolean;
  browse?: "directory";
  /** Recompute this field from the others until the user edits it. */
  derive?: (values: DialogValues) => string;
}

export type DialogValues = Record<string, string | boolean>;

export interface DialogSpec {
  title: string;
  message?: ReactNode;
  fields?: DialogField[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  wide?: boolean;
  resolve: (values: DialogValues | null) => void;
}

export interface MenuItem {
  label?: string;
  icon?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  hint?: string;
  submenu?: MenuItem[];
}

export type ModalName = "prefs" | null;
export type PrefsTab = "general" | "appearance" | "integrations" | "ssh";
export type ManagerTab = "open" | "clone" | "init";

interface UiState {
  tabs: RepoInfo[];
  active: string | null;
  toasts: Toast[];
  dialog: DialogSpec | null;
  menu: { x: number; y: number; items: MenuItem[] } | null;
  modal: ModalName;
  prefsTab: PrefsTab;
  managerTab: ManagerTab;
  accountsVersion: number;
  /** Clone screen source: "url", a service id or an account id. */
  cloneSource: string | null;
  /** URL to prefill on the Clone screen (from a mobyd://clone link). */
  cloneUrl: string | null;
  /** Service to show first in Preferences → Integrations. */
  integrationService: "github" | "ghe" | "gitlab" | "gitlab-self" | "gitea" | null;
  /** True once tabs from the last session were restored; guards saving an empty list. */
  restored: boolean;
  setTabs: (tabs: RepoInfo[], active: string | null) => void;
  addTab: (info: RepoInfo) => void;
  closeTab: (root: string) => void;
  setActive: (root: string) => void;
  pushToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
  holdToast: (id: number, held: boolean) => void;
  setDialog: (d: DialogSpec | null) => void;
  setMenu: (m: UiState["menu"]) => void;
  setModal: (m: ModalName) => void;
  bumpAccounts: () => void;
}

let toastId = 1;

export const useUi = create<UiState>((set, get) => ({
  tabs: [],
  active: null,
  toasts: [],
  dialog: null,
  menu: null,
  modal: null,
  prefsTab: "integrations",
  managerTab: "open",
  accountsVersion: 0,
  cloneSource: null,
  cloneUrl: null,
  integrationService: null,
  restored: false,
  setTabs: (tabs, active) => set({ tabs, active, restored: true }),
  addTab: (info) => {
    const { tabs } = get();
    if (tabs.some((t) => t.root === info.root)) set({ active: info.root });
    else set({ tabs: [...tabs, info], active: info.root });
  },
  closeTab: (root) => {
    const { tabs, active } = get();
    const idx = tabs.findIndex((t) => t.root === root);
    const next = tabs.filter((t) => t.root !== root);
    let nextActive = active;
    if (active === root) nextActive = next[Math.min(idx, next.length - 1)]?.root ?? null;
    set({ tabs: next, active: nextActive });
  },
  setActive: (root) => set({ active: root }),
  pushToast: (t) => {
    const id = toastId++;
    set({ toasts: [...get().toasts, { ...t, id }].slice(-5) });
    if (t.sticky) return;
    const ttl = t.kind === "error" ? 12000 : t.kind === "warning" ? 8000 : 4500;
    const expire = () => {
      if (get().toasts.find((x) => x.id === id)?.held) setTimeout(expire, 1500);
      else get().dismissToast(id);
    };
    setTimeout(expire, ttl);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  holdToast: (id, held) => set({ toasts: get().toasts.map((t) => (t.id === id ? { ...t, held } : t)) }),
  setDialog: (dialog) => set({ dialog }),
  setMenu: (menu) => set({ menu }),
  setModal: (modal) => set({ modal }),
  bumpAccounts: () => set({ accountsVersion: get().accountsVersion + 1 }),
}));

export const toast = {
  info: (title: string, detail?: string) => useUi.getState().pushToast({ kind: "info", title, detail }),
  success: (title: string, detail?: string) => useUi.getState().pushToast({ kind: "success", title, detail }),
  warning: (title: string, detail?: string) => useUi.getState().pushToast({ kind: "warning", title, detail }),
  error: (title: string, detail?: string) => useUi.getState().pushToast({ kind: "error", title, detail }),
};

/** Open the shared form dialog and resolve with its values (or null on cancel). */
export function ask(spec: Omit<DialogSpec, "resolve">): Promise<DialogValues | null> {
  return new Promise((resolve) => {
    useUi.getState().setDialog({
      ...spec,
      resolve: (v) => {
        useUi.getState().setDialog(null);
        resolve(v);
      },
    });
  });
}

export async function confirmAction(title: string, message: ReactNode, confirmLabel = t("확인"), danger = false) {
  const r = await ask({ title, message, confirmLabel, danger });
  return r !== null;
}

export function openMenu(e: { clientX: number; clientY: number; preventDefault: () => void }, items: MenuItem[]) {
  e.preventDefault();
  useUi.getState().setMenu({ x: e.clientX, y: e.clientY, items });
}

export function openPrefs(tab: PrefsTab = "general", service: UiState["integrationService"] = null) {
  useUi.setState({ modal: "prefs", prefsTab: tab, integrationService: service });
}

/** Show the repository manager (the "new tab" screen) on a given section. */
export function openManager(tab: ManagerTab = "open", cloneSource: string | null = null) {
  useUi.setState({ active: null, managerTab: tab, ...(cloneSource ? { cloneSource } : {}) });
}
