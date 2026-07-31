import { describe, it, expect } from "vitest";
import { leafCategory, topLevelCategory } from "./categoryKey";

describe("topLevelCategory — the grouping key", () => {
  it("takes the outermost segment of an Amazon pipe hierarchy", () => {
    expect(topLevelCategory("Home&Kitchen|HomeDecor|Lighting")).toBe("Home&Kitchen");
    expect(topLevelCategory("Electronics|Accessories|Cables")).toBe("Electronics");
    expect(topLevelCategory("Computers&Accessories|Components|InternalSolidStateDrives")).toBe(
      "Computers&Accessories",
    );
  });

  // Flat data is a hierarchy of length one, which is why one rule serves both
  // data models with no branching on the source.
  it("returns a flat category unchanged, because it is already top level", () => {
    expect(topLevelCategory("Electronics")).toBe("Electronics");
    expect(topLevelCategory("Kitchen Appliances")).toBe("Kitchen Appliances");
    expect(topLevelCategory("Uncategorized")).toBe("Uncategorized");
  });

  it("trims segments and collapses internal whitespace", () => {
    expect(topLevelCategory("  Home&Kitchen | HomeDecor ")).toBe("Home&Kitchen");
    expect(topLevelCategory("Kitchen   Appliances")).toBe("Kitchen Appliances");
  });

  it("skips empty leading segments rather than returning a blank key", () => {
    expect(topLevelCategory("|Electronics|Cables")).toBe("Electronics");
    expect(topLevelCategory("  |  | Electronics")).toBe("Electronics");
  });

  it("yields an empty key when there is no category at all", () => {
    expect(topLevelCategory("")).toBe("");
    expect(topLevelCategory("   ")).toBe("");
    expect(topLevelCategory("|")).toBe("");
  });

  // Casing is NOT normalised: these are display labels as well as keys, and the
  // source spells each category one way throughout.
  it("preserves casing, so the key doubles as the displayed label", () => {
    expect(topLevelCategory("Home&Kitchen|X")).toBe("Home&Kitchen");
    expect(topLevelCategory("home&kitchen|X")).toBe("home&kitchen");
  });
});

describe("leafCategory — what the product is", () => {
  it("takes the innermost segment of a hierarchy", () => {
    expect(leafCategory("Home&Kitchen|HomeDecor|Lighting")).toBe("Lighting");
    expect(leafCategory("Electronics|Accessories|Cables")).toBe("Cables");
  });

  it("returns a flat category unchanged — it is its own leaf", () => {
    expect(leafCategory("Electronics")).toBe("Electronics");
  });

  it("handles trailing empties and blanks", () => {
    expect(leafCategory("Electronics|Cables|")).toBe("Cables");
    expect(leafCategory("")).toBe("");
  });
});

describe("the two readings together", () => {
  // The distinction that motivates the whole change: on the real dataset these
  // differ 207 ways to 9, so grouping on the leaf would make groups of one.
  it("differ for a hierarchy and coincide for flat data", () => {
    const deep = "Home&Kitchen|HomeDecor|Lighting";
    expect(topLevelCategory(deep)).not.toBe(leafCategory(deep));

    const flat = "Electronics";
    expect(topLevelCategory(flat)).toBe(leafCategory(flat));
  });
});
