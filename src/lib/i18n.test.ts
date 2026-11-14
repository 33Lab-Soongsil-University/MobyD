import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { EN } from "./i18n.en";
import { plural, setLangForTest, t } from "./i18n";

const SRC = path.resolve(__dirname, "..");
const HANGUL = /[가-힣]/;
const SKIP = new Set(["lib/i18n.ts", "lib/i18n.en.ts"]);
const CALLEES = new Set(["t", "tj", "tr"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Message ids used in the code, and Korean text that is not wrapped in t()/tj(). */
function scan() {
  const ids = new Set<string>();
  const unwrapped: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file);
    if (SKIP.has(rel)) continue;
    const text = fs.readFileSync(file, "utf8");
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const allowed = new Set<ts.Node>();
    const where = (n: ts.Node) => `${rel}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}`;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && CALLEES.has(n.expression.text)) {
        const a = n.arguments[0];
        if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) {
          ids.add(a.text);
          allowed.add(a);
        }
      }
      if (!allowed.has(n)) {
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isJsxText(n)) && HANGUL.test(n.text)) {
          unwrapped.push(`${where(n)} ${n.text.trim().slice(0, 50)}`);
        } else if (ts.isTemplateExpression(n) && [n.head, ...n.templateSpans.map((s) => s.literal)].some((p) => HANGUL.test(p.text))) {
          unwrapped.push(`${where(n)} \`${n.head.text.slice(0, 50)}…\``);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return { ids, unwrapped };
}

const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("translations", () => {
  const { ids, unwrapped } = scan();

  it("wraps every Korean UI string in t()/tj()", () => {
    expect(unwrapped).toEqual([]);
  });

  it("has an English entry for every message", () => {
    expect([...ids].filter((id) => !(id in EN))).toEqual([]);
  });

  it("keeps the same {slots} in English", () => {
    const bad = Object.entries(EN)
      .filter(([ko, en]) => typeof en === "string" && slots(ko).join() !== slots(en).join())
      .map(([ko]) => ko);
    expect(bad).toEqual([]);
  });

  it("has no leftover entries", () => {
    expect(Object.keys(EN).filter((k) => !ids.has(k))).toEqual([]);
  });

  it("switches language", () => {
    setLangForTest("en");
    expect(t("커밋")).toBe("Commit");
    expect(t("{service}에 연결", { service: "GitHub.com" })).toBe("Connect to GitHub.com");
    expect(t("파일 {length}개 커밋", { length: 1 })).toBe("Commit 1 file");
    expect(t("선택한 {n}개 복제", { n: 4 })).toBe("Clone 4 selected");
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(3, "file")).toBe("3 files");
    setLangForTest("ko");
    expect(t("커밋")).toBe("커밋");
  });
});
