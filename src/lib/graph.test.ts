import { describe, expect, it } from "vitest";
import { graphWidth, groupRefs, initials, laneX, segmentPath } from "./graph";
import type { RefInfo } from "./types";

const ref = (p: Partial<RefInfo>): RefInfo => ({
  name: "",
  short: "",
  kind: "local",
  target: "abc",
  upstream: null,
  ahead: 0,
  behind: 0,
  upstreamGone: false,
  isHead: false,
  remote: null,
  date: 0,
  subject: "",
  ...p,
});

describe("segmentPath", () => {
  it("draws straight passes and elbows", () => {
    expect(segmentPath({ kind: "pass", from: 1, to: 1, color: 0 }, 0, 30)).toBe(`M${laneX(1)} 0L${laneX(1)} 30`);
    expect(segmentPath({ kind: "enter", from: 0, to: 0, color: 0 }, 0, 30)).toBe(`M${laneX(0)} 0L${laneX(0)} 15`);
    expect(segmentPath({ kind: "leave", from: 0, to: 2, color: 0 }, 0, 30)).toBe(
      `M${laneX(0)} 15Q${laneX(2)} 15 ${laneX(2)} 30`,
    );
    expect(segmentPath({ kind: "enter", from: 2, to: 0, color: 0 }, 0, 30)).toBe(
      `M${laneX(2)} 0Q${laneX(2)} 15 ${laneX(0)} 15`,
    );
  });

  it("sizes the graph column by lane count", () => {
    expect(graphWidth(3)).toBeGreaterThan(graphWidth(1));
    expect(graphWidth(0)).toBe(graphWidth(1));
  });
});

describe("groupRefs", () => {
  it("merges local and remote branches with the same name", () => {
    const groups = groupRefs([
      ref({ short: "origin/main", kind: "remote", remote: "origin" }),
      ref({ short: "main", kind: "local", isHead: true }),
      ref({ short: "v1.0", kind: "tag" }),
      ref({ short: "origin/feature", kind: "remote", remote: "origin" }),
    ]);
    expect(groups[0].label).toBe("main");
    expect(groups[0].isHead).toBe(true);
    expect(groups[0].remotes).toHaveLength(1);
    expect(groups.find((g) => g.label === "feature")?.local).toBeNull();
    expect(groups.find((g) => g.kind === "tag")?.label).toBe("v1.0");
  });
});

describe("initials", () => {
  it("handles western, korean and handle-style names", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("김경진")).toBe("김경");
    expect(initials("dolphin_bot")).toBe("DB");
    expect(initials("")).toBe("?");
  });
});
