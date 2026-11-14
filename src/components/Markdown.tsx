import { Fragment, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * A deliberately small Markdown renderer for PR descriptions and comments.
 * It never injects HTML: raw tags are dropped and everything becomes React
 * text nodes, so forge content cannot run script inside the app (which has
 * IPC access to git).
 */

function stripHtml(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(details|summary|div|span|p|br|sup|sub|picture|source|img|a|b|i|em|strong|kbd)[^>]*>/gi, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function safeHref(href: string): string | null {
  return /^https?:\/\//i.test(href) ? href : null;
}

export function inline(text: string, keyBase = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${k++}`;
    if (tok.startsWith("`")) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else {
      const link = tok.startsWith("[") ? /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok) : null;
      const label = link ? link[1] : tok;
      const href = safeHref(link ? link[2] : tok);
      out.push(
        href ? (
          <a
            key={key}
            href={href}
            onClick={(e) => {
              e.preventDefault();
              openUrl(href).catch(() => {});
            }}
          >
            {label}
          </a>
        ) : (
          <Fragment key={key}>{label}</Fragment>
        ),
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source }: { source: string }) {
  const lines = stripHtml(source).replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={key++} className="md-code">{body.join("\n")}</pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(
        <div key={key++} className={`md-h md-h${Math.min(h[1].length, 3)}`}>
          {inline(h[2], `h${key}`)}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
      blocks.push(
        <ul key={key++} className="md-list">
          {items.map((it, j) => {
            const task = /^\[( |x|X)\]\s+(.*)$/.exec(it);
            return (
              <li key={j} className={task ? "task" : ""}>
                {task && <input type="checkbox" checked={task[1] !== " "} readOnly />}
                {inline(task ? task[2] : it, `l${key}-${j}`)}
              </li>
            );
          })}
        </ul>,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push(<blockquote key={key++}>{inline(quote.join(" "), `q${key}`)}</blockquote>);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i++].trim().slice(1, -1).split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
      }
      blocks.push(
        <table key={key++} className="md-table">
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (ri === 0 ? <th key={ci}>{inline(c, `t${ri}${ci}`)}</th> : <td key={ci}>{inline(c, `t${ri}${ci}`)}</td>))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*([-*+]|\d+\.)\s|\s*>|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key++}>{inline(para.join(" "), `p${key}`)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
