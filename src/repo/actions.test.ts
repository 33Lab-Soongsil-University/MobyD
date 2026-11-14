import { describe, expect, it } from "vitest";
import { blockedByLocalChanges } from "./actions";

describe("stash-and-checkout offer", () => {
  it("recognises git refusing to switch over uncommitted or untracked files", () => {
    expect(
      blockedByLocalChanges(
        "git checkout: error: Your local changes to the following files would be overwritten by checkout:\n\tREADME.md\nPlease commit your changes or stash them before you switch branches.\nAborting",
      ),
    ).toBe(true);
    expect(blockedByLocalChanges("git switch: error: The following untracked working tree files would be overwritten by checkout:\n\tnew.txt")).toBe(true);
  });

  it("leaves other failures as errors", () => {
    expect(blockedByLocalChanges("git checkout: error: pathspec 'nope' did not match any file(s) known to git")).toBe(false);
    expect(blockedByLocalChanges("git switch: fatal: a branch named 'x' already exists")).toBe(false);
  });
});
