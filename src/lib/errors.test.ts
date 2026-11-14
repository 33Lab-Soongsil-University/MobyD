import { afterEach, describe, expect, it } from "vitest";
import { friendlyText, humanize, rawFor } from "./errors";
import { setLangForTest } from "./i18n";

// Real output captured from git 2.5x / the MobyD backend.
const CHECKOUT = `git checkout: error: Your local changes to the following files would be overwritten by checkout:
\tREADME.md
\tsrc/sea.ts
Please commit your changes or stash them before you switch branches.
Aborting`;
const PUSH = `git push: To https://github.com/pequod/app.git
 ! [rejected]        main -> main (fetch first)
error: failed to push some refs to 'https://github.com/pequod/app.git'
hint: Updates were rejected because the remote contains work that you do not
hint: have locally.`;
const AUTH = "git fetch: fatal: could not read Username for 'https://github.com': terminal prompts disabled";
const SSH = "SSH office-pc: ssh: connect to host 192.168.1.9 port 22: Operation timed out";
const NOT_MERGED = "git branch: error: The branch 'feature/harpoon' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D feature/harpoon'.";

describe("humanize git errors", () => {
  afterEach(() => setLangForTest("ko"));

  it("explains uncommitted changes blocking a checkout and lists the files", () => {
    setLangForTest("ko");
    const f = humanize(CHECKOUT);
    expect(f.known).toBe(true);
    expect(f.message).toContain("커밋하지 않은 변경이 있어서 브랜치를 바꿀 수 없습니다");
    expect(f.files).toEqual(["README.md", "src/sea.ts"]);
  });

  it("explains a rejected push, auth and network problems in English", () => {
    setLangForTest("en");
    expect(humanize(PUSH).message).toMatch(/^The push was rejected because the remote has new commits/);
    expect(humanize(AUTH).message).toMatch(/needs you to sign in/);
    expect(humanize(SSH).message).toMatch(/^Couldn't connect to office-pc\./);
    expect(humanize(NOT_MERGED).message).toMatch(/^'feature\/harpoon' has commits that aren't merged yet/);
  });

  it("cleans unknown git output down to its core sentence", () => {
    const f = humanize("git frobnicate: fatal: something odd happened here\nhint: try again later");
    expect(f.known).toBe(false);
    expect(f.message).toBe("Something odd happened here");
  });

  it("passes MobyD's own sentences through unchanged", () => {
    expect(humanize("커밋 메시지를 입력하세요").message).toBe("커밋 메시지를 입력하세요");
  });

  it("keeps the original text for the details view", () => {
    setLangForTest("ko");
    const text = friendlyText(CHECKOUT);
    expect(text).toContain("• src/sea.ts");
    expect(rawFor(text)).toBe(CHECKOUT);
    expect(rawFor(friendlyText("커밋 메시지를 입력하세요"))).toBeNull();
  });
});
