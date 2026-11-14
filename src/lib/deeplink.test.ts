import { describe, expect, it } from "vitest";
import { cloneLink, parseLink, repoLink } from "./deeplink";

describe("mobyd:// links", () => {
  it("opens local and SSH repositories", () => {
    expect(parseLink(repoLink("/Users/me/code/pequod"))).toEqual({ kind: "open", path: "/Users/me/code/pequod" });
    expect(parseLink(repoLink("ssh://devbox/E:/code/pequod-app"))).toEqual({ kind: "open", path: "ssh://devbox/E:/code/pequod-app" });
    expect(parseLink("mobyd://open?path=~/code/app")).toEqual({ kind: "open", path: "~/code/app" });
    expect(parseLink("MOBYD://open?path=%2Ftmp%2Fr")).toEqual({ kind: "open", path: "/tmp/r" });
  });

  it("prefills clone URLs but only for real remotes", () => {
    expect(parseLink(cloneLink("https://github.com/pequod/app.git"))).toEqual({ kind: "clone", url: "https://github.com/pequod/app.git" });
    expect(parseLink(cloneLink("git@github.com:pequod/app.git"))).toEqual({ kind: "clone", url: "git@github.com:pequod/app.git" });
    expect(parseLink(cloneLink("file:///etc"))).toBeNull();
    expect(parseLink(cloneLink("ext::sh -c touch% /tmp/x"))).toBeNull();
  });

  it("launches on a bare link and rejects anything else", () => {
    expect(parseLink("mobyd://")).toEqual({ kind: "launch" });
    expect(parseLink("mobyd://open?path=relative/path")).toBeNull();
    expect(parseLink("mobyd://delete?path=/")).toBeNull();
    expect(parseLink("https://example.com")).toBeNull();
    expect(parseLink("not a url")).toBeNull();
  });
});
