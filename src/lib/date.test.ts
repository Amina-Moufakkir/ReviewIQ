import { describe, it, expect } from "vitest";
import { isValidIsoDate } from "./date";

describe("isValidIsoDate — valid dates", () => {
  it("accepts standard calendar dates", () => {
    for (const d of ["2026-01-01", "2026-02-28", "2026-12-31", "2025-06-15"]) {
      expect(isValidIsoDate(d), d).toBe(true);
    }
  });

  it("accepts a leap day in a leap year", () => {
    expect(isValidIsoDate("2024-02-29")).toBe(true);
  });

  it("handles century leap-year rules", () => {
    expect(isValidIsoDate("2000-02-29")).toBe(true); // divisible by 400
    expect(isValidIsoDate("1900-02-29")).toBe(false); // divisible by 100, not 400
  });
});

describe("isValidIsoDate — invalid calendar dates", () => {
  it("rejects Feb 29 in a non-leap year", () => {
    expect(isValidIsoDate("2026-02-29")).toBe(false);
  });

  it("rejects impossible days of the month", () => {
    expect(isValidIsoDate("2026-02-30")).toBe(false);
    expect(isValidIsoDate("2026-04-31")).toBe(false);
    expect(isValidIsoDate("2026-01-32")).toBe(false);
  });

  it("rejects out-of-range months", () => {
    expect(isValidIsoDate("2026-00-10")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
  });

  it("rejects day or month zero", () => {
    expect(isValidIsoDate("2026-05-00")).toBe(false);
  });
});

describe("isValidIsoDate — malformed formats", () => {
  it("requires exactly YYYY-MM-DD", () => {
    for (const d of ["not-a-date", "2026-2-3", "20260101", "2026/01/01", "2026-01-01T00:00", "2026-01-01 ", ""]) {
      expect(isValidIsoDate(d), d).toBe(false);
    }
  });
});
