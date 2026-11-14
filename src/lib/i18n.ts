// UI language. Korean source strings are the message ids (gettext style):
// `t("커밋")` returns "Commit" in English and the id itself in Korean, so a
// missing translation degrades to Korean instead of a blank. `{name}` slots are
// filled from `vars`. The coverage test (i18n.test.ts) fails when a Korean
// literal is not wrapped in `t()` or has no English entry.
import { EN, plural, type EnEntry, type Vars } from "./i18n.en";

export { plural };
export type { EnEntry, Vars };

export type Lang = "ko" | "en";
export type LangPref = "system" | Lang;

const KEY = "mobyd.lang";

function systemLang(): Lang {
  const langs = typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language];
  const first = langs.find(Boolean)?.toLowerCase() ?? "en";
  return first.startsWith("ko") ? "ko" : "en";
}

export function getLangPref(): LangPref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "ko" || v === "en" || v === "system") return v;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

function resolve(p: LangPref): Lang {
  return p === "system" ? systemLang() : p;
}

let current: Lang = resolve(getLangPref());

export function lang(): Lang {
  return current;
}

/** BCP 47 tag for Intl formatters. */
export function locale(): string {
  return current === "ko" ? "ko-KR" : "en-US";
}


function fill(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function t(ko: string, vars?: Vars): string {
  if (current === "ko") return fill(ko, vars);
  const en = EN[ko];
  if (en === undefined) return fill(ko, vars);
  return typeof en === "function" ? en(vars ?? {}) : fill(en, vars);
}

/** Store the preference and apply it. The page reloads so every view (and cached label) switches at once. */
export function setLangPref(p: LangPref, reload = true) {
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* ignore */
  }
  const next = resolve(p);
  if (next === current) return;
  current = next;
  if (reload && typeof location !== "undefined") location.reload();
}

/** Language names are shown in their own language. */
export const LANG_NAMES: Record<Lang, string> = { ko: "한국어", en: "English" };

/** Palette entry that switches language, written in the language it switches to. */
export const LANG_SWITCH = {
  toKo: "언어: 한국어로 바꾸기",
  toEn: "Language: switch to English",
  words: "language 언어 english korean 영어 한국어",
};

/** For tests. */
export function setLangForTest(l: Lang) {
  current = l;
}
