import { describe, it, expect } from "vitest";
import { matchesKeyword } from "./matchKeyword";

describe("matchesKeyword — whole-word single tokens", () => {
  it("matches a single word as a whole word", () => {
    expect(matchesKeyword("The chair is easy to clean", "clean")).toBe(true);
  });

  it("does not match a keyword embedded in a longer word", () => {
    expect(matchesKeyword("cleaner teeth", "clean")).toBe(false);
    expect(matchesKeyword("cleaner teeth", "cleaning")).toBe(false);
    expect(matchesKeyword("maintenance", "main")).toBe(false);
  });

  it("is case-insensitive in both directions", () => {
    expect(matchesKeyword("CLEAN the tray", "clean")).toBe(true);
    expect(matchesKeyword("clean the tray", "CLEAN")).toBe(true);
  });

  it("respects boundaries at punctuation and string edges", () => {
    expect(matchesKeyword("clean.", "clean")).toBe(true);
    expect(matchesKeyword("(clean)", "clean")).toBe(true);
    expect(matchesKeyword("preclean", "clean")).toBe(false);
  });
});

describe("matchesKeyword — multi-word phrases", () => {
  it("matches a bounded phrase", () => {
    expect(matchesKeyword("the build quality feels sturdy", "build quality")).toBe(true);
  });

  it("does not match when only part of the phrase is present", () => {
    expect(matchesKeyword("hard to build", "build quality")).toBe(false);
  });

  it("matches hyphenated keywords", () => {
    expect(matchesKeyword("it feels well-made", "well-made")).toBe(true);
  });
});

describe("matchesKeyword — safety", () => {
  it("escapes regex metacharacters in the keyword", () => {
    expect(matchesKeyword("I use c++ daily", "c++")).toBe(true);
    expect(matchesKeyword("I use cxx daily", "c++")).toBe(false);
  });

  it("returns false for an empty keyword", () => {
    expect(matchesKeyword("anything", "")).toBe(false);
  });
});
