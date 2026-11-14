import { describe, expect, it } from "vitest";
import { basename, dirname, displayRoot, joinPath, relativeTime, repoBaseName, splitPathTail, splitTail } from "./format";
import { setLangForTest } from "./i18n";

setLangForTest("ko");

describe("format", () => {
  it("formats relative times in Korean", () => {
    const now = 1_000_000;
    expect(relativeTime(now - 10, now)).toBe("방금");
    expect(relativeTime(now - 7200, now)).toBe("2시간 전");
    expect(relativeTime(now - 86400 * 3, now)).toBe("3일 전");
  });

  it("handles paths", () => {
    expect(basename("/Users/me/repo/")).toBe("repo");
    expect(dirname("/Users/me/repo")).toBe("/Users/me");
    expect(joinPath("/Users/me/", "x")).toBe("/Users/me/x");
  });
});

describe("names that are shortened in the middle", () => {
  it("keeps the distinguishing tail of a long name", () => {
    expect(splitTail("pequod-app-staging")).toEqual(["pequod-app", "-staging"]);
    expect(splitTail("codex_projector_stimulus_20260911")).toEqual(["codex_projector_stimulus", "_20260911"]);
    expect(splitTail("pequod-app")).toEqual(["pequod-app", ""]);
    expect(splitTail("사용자 지정 Office 서식 파일").join("")).toBe("사용자 지정 Office 서식 파일");
  });

  it("strips the host suffix and shows ssh roots as host:path", () => {
    expect(repoBaseName("pequod-app @ devbox", "devbox")).toBe("pequod-app");
    expect(repoBaseName("a @ b @ devbox", "devbox")).toBe("a @ b");
    expect(repoBaseName("plain", null)).toBe("plain");
    expect(displayRoot("ssh://devbox/E:/code/pequod-app")).toBe("devbox:E:/code/pequod-app");
    expect(displayRoot("ssh://studio/Users/g/repo")).toBe("studio:/Users/g/repo");
    expect(displayRoot("/Users/g/repo")).toBe("/Users/g/repo");
  });
});

describe("paths keep their end visible", () => {
  it("splits long paths before the last two segments", () => {
    expect(splitPathTail("/private/tmp/some/very/long/folder/name/scratchpad/r-pod")).toEqual(["/private/tmp/some/very/long/folder/name", "/scratchpad/r-pod"]);
    expect(splitPathTail("/Users/me/repo")).toEqual(["/Users/me/repo", ""]);
  });
});
