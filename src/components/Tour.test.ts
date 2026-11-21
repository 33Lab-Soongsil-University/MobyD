import { describe, expect, it } from "vitest";
import { placeCard } from "./Tour";

const card = { width: 340, height: 180 };

describe("placeCard", () => {
  it("centres the card when there is no target", () => {
    expect(placeCard(null, card, 1440, 880)).toEqual({ left: 550, top: 350 });
  });
  it("puts the card below a target near the top", () => {
    expect(placeCard({ left: 100, top: 40, width: 120, height: 40 }, card, 1440, 880)).toEqual({ left: 100, top: 92 });
  });
  it("goes above a target near the bottom and stays on screen", () => {
    expect(placeCard({ left: 1300, top: 800, width: 120, height: 40 }, card, 1440, 880)).toEqual({ left: 1088, top: 608 });
  });
  it("goes beside a tall target", () => {
    expect(placeCard({ left: 4, top: 88, width: 246, height: 788 }, card, 1440, 880)).toEqual({ left: 262, top: 88 });
  });
});
