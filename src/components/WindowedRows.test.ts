import { describe, expect, it } from "vitest";
import { visibleRange } from "./WindowedRows";

describe("visibleRange", () => {
  it("covers the rows in view plus the overscan", () => {
    // list starts 100px above the panel's top edge, panel is 270px tall, rows are 27px
    expect(visibleRange(-100, 0, 270, 27, 4000, 2)).toEqual([1, 16]);
  });
  it("stays inside the list", () => {
    expect(visibleRange(0, 0, 270, 27, 5, 12)).toEqual([0, 5]);
    expect(visibleRange(-1_000_000, 0, 270, 27, 4000, 12)).toEqual([4000, 4000]);
  });
  it("is empty-safe when the list is below the view", () => {
    expect(visibleRange(5000, 0, 270, 27, 4000, 2)).toEqual([0, 0]);
  });
});
