import { describe, expect, it } from "vitest";
import { isRemotePath, sshUri } from "./actions";

describe("ssh repository identities", () => {
  it("builds ssh:// URIs for posix and windows paths", () => {
    expect(sshUri("studio", "/Users/me/repo")).toBe("ssh://studio/Users/me/repo");
    expect(sshUri("pc", "C:/Users/me/repo")).toBe("ssh://pc/C:/Users/me/repo");
    expect(isRemotePath("ssh://studio/x")).toBe(true);
    expect(isRemotePath("/Users/me/repo")).toBe(false);
  });
});
