import { Fragment, type ReactNode } from "react";
import { t } from "./i18n";

/**
 * Translate a sentence whose `{slots}` are React elements (bold names, code,
 * links), so the whole sentence stays one message and word order can change:
 * `tj("{a}을(를) {b}에 병합합니다.", { a: <b>x</b>, b: <b>y</b> })`.
 */
export function tj(ko: string, parts: Record<string, ReactNode>): ReactNode {
  const text = t(ko);
  const out: ReactNode[] = [];
  let last = 0;
  const re = /\{(\w+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] in parts ? <Fragment key={out.length}>{parts[m[1]]}</Fragment> : m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
