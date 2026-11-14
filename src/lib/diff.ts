// Unified diff parsing plus helpers for hunk staging and split view.

export type LineKind = "add" | "del" | "ctx" | "meta";

export interface DiffLine {
  kind: LineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  section: string;
  lines: DiffLine[];
}

export interface FileDiff {
  /** Header lines before the first hunk (`diff --git`, `index`, `---`, `+++` …). */
  headerLines: string[];
  oldPath: string | null;
  newPath: string | null;
  binary: boolean;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
  additions: number;
  deletions: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function stripPrefix(p: string): string | null {
  if (p === "/dev/null") return null;
  const t = p.replace(/\t.*$/, "");
  return t.startsWith("a/") || t.startsWith("b/") ? t.slice(2) : t;
}

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const start = () => {
    file = {
      headerLines: [],
      oldPath: null,
      newPath: null,
      binary: false,
      isNew: false,
      isDeleted: false,
      hunks: [],
      additions: 0,
      deletions: 0,
    };
    files.push(file);
    hunk = null;
  };

  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    if (line.startsWith("diff --git ") || line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      start();
      file!.headerLines.push(line);
      continue;
    }
    if (!file) start();
    const f = file!;
    const m = HUNK_RE.exec(line);
    if (m) {
      hunk = {
        header: line,
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5].trim(),
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      f.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      f.headerLines.push(line);
      if (line.startsWith("--- ")) f.oldPath = stripPrefix(line.slice(4));
      else if (line.startsWith("+++ ")) f.newPath = stripPrefix(line.slice(4));
      else if (line.startsWith("new file mode")) f.isNew = true;
      else if (line.startsWith("deleted file mode")) f.isDeleted = true;
      else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) f.binary = true;
      continue;
    }
    const h = hunk as Hunk;
    const c = line[0];
    if (c === "+") {
      h.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
      f.additions++;
    } else if (c === "-") {
      h.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
      f.deletions++;
    } else if (c === "\\") {
      h.lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    } else {
      h.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return files;
}

/** Serialize one hunk as a standalone patch accepted by `git apply`. */
export function hunkPatch(file: FileDiff, hunk: Hunk): string {
  const header = file.headerLines.filter(
    (l) =>
      l.startsWith("diff --git") ||
      l.startsWith("--- ") ||
      l.startsWith("+++ ") ||
      l.startsWith("new file mode") ||
      l.startsWith("deleted file mode") ||
      l.startsWith("old mode") ||
      l.startsWith("new mode"),
  );
  const body = hunk.lines.map((l) => {
    if (l.kind === "meta") return l.text;
    const p = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
    return p + l.text;
  });
  return [...header, hunk.header, ...body].join("\n") + "\n";
}

/**
 * Build a patch for a subset of lines inside a hunk. Unselected additions are
 * dropped; unselected deletions become context. `--recount` on the git side
 * fixes the hunk header counts.
 */
export function linesPatch(file: FileDiff, hunk: Hunk, selected: Set<number>, reverse = false): string {
  const header = file.headerLines.filter(
    (l) => l.startsWith("diff --git") || l.startsWith("--- ") || l.startsWith("+++ "),
  );
  const body: string[] = [];
  hunk.lines.forEach((l, i) => {
    const picked = selected.has(i);
    if (l.kind === "ctx") body.push(" " + l.text);
    else if (l.kind === "meta") body.push(l.text);
    else if (l.kind === "add") {
      if (picked) body.push("+" + l.text);
      else if (reverse) body.push(" " + l.text);
    } else if (l.kind === "del") {
      if (picked) body.push("-" + l.text);
      else if (!reverse) body.push(" " + l.text);
    }
  });
  return [...header, hunk.header, ...body].join("\n") + "\n";
}

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Pair deletions with additions for side-by-side rendering. */
export function splitRows(hunk: Hunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const l of hunk.lines) {
    if (l.kind === "del") dels.push(l);
    else if (l.kind === "add") adds.push(l);
    else {
      flush();
      if (l.kind === "ctx") rows.push({ left: l, right: l });
    }
  }
  flush();
  return rows;
}
