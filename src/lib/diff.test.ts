import { describe, expect, it } from "vitest";
import { hunkPatch, linesPatch, parseDiff, splitRows } from "./diff";

const SAMPLE = `diff --git a/src/pod.ts b/src/pod.ts
index 1111111..2222222 100644
--- a/src/pod.ts
+++ b/src/pod.ts
@@ -1,4 +1,5 @@ export function pod()
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
 const e = 6;
@@ -10,2 +11,2 @@
-old
+new
\\ No newline at end of file
`;

describe("parseDiff", () => {
  it("parses headers, hunks and line numbers", () => {
    const [f] = parseDiff(SAMPLE);
    expect(f.oldPath).toBe("src/pod.ts");
    expect(f.newPath).toBe("src/pod.ts");
    expect(f.hunks).toHaveLength(2);
    expect(f.additions).toBe(3);
    expect(f.deletions).toBe(2);
    const h = f.hunks[0];
    expect(h.section).toBe("export function pod()");
    expect(h.lines[1]).toMatchObject({ kind: "del", oldNo: 2, newNo: null });
    expect(h.lines[3]).toMatchObject({ kind: "add", newNo: 3 });
    expect(h.lines[4]).toMatchObject({ kind: "ctx", oldNo: 3, newNo: 4 });
    expect(f.hunks[1].lines[2].kind).toBe("meta");
  });

  it("detects new, deleted and binary files", () => {
    const text = `diff --git a/x.png b/x.png
new file mode 100644
index 0000000..abc
Binary files /dev/null and b/x.png differ
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;
    const files = parseDiff(text);
    expect(files).toHaveLength(2);
    expect(files[0].isNew && files[0].binary).toBe(true);
    expect(files[1].isDeleted).toBe(true);
    expect(files[1].newPath).toBeNull();
    expect(files[1].hunks[0].oldCount).toBe(1);
    expect(files[1].hunks[0].newCount).toBe(0);
  });
});

describe("patch builders", () => {
  it("builds a standalone hunk patch", () => {
    const [f] = parseDiff(SAMPLE);
    const patch = hunkPatch(f, f.hunks[1]);
    expect(patch).toBe(
      "diff --git a/src/pod.ts b/src/pod.ts\n--- a/src/pod.ts\n+++ b/src/pod.ts\n@@ -10,2 +11,2 @@\n-old\n+new\n\\ No newline at end of file\n",
    );
  });

  it("keeps only selected lines", () => {
    const [f] = parseDiff(SAMPLE);
    // select only "+const c = 4;" (index 3)
    const patch = linesPatch(f, f.hunks[0], new Set([3]));
    expect(patch).toContain(" const b = 2;");
    expect(patch).toContain("+const c = 4;");
    expect(patch).not.toContain("+const b = 3;");
  });
});

describe("splitRows", () => {
  it("pairs deletions with additions", () => {
    const [f] = parseDiff(SAMPLE);
    const rows = splitRows(f.hunks[0]);
    expect(rows[1].left?.text).toBe("const b = 2;");
    expect(rows[1].right?.text).toBe("const b = 3;");
    expect(rows[2].left).toBeNull();
    expect(rows[2].right?.text).toBe("const c = 4;");
  });
});
