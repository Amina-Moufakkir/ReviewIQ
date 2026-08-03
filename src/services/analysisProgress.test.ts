import { describe, it, expect } from "vitest";
import {
  PHASE_ORDER,
  isProgressAdvance,
  phaseIndex,
  type AnalysisProgress,
} from "./analysisProgress";

/**
 * Progress must never move backward.
 *
 * An analyst reads a progress line as a promise about how much work is left. A
 * count that drops, or a stage that reverts, breaks that promise and makes the
 * run look broken when it is fine. Two ordinary things push it that way — a
 * superseded run's callback landing late, and two updates racing within a stage
 * — so the rule is enforced here rather than left to arrive in order.
 */

function progress(over: Partial<AnalysisProgress> = {}): AnalysisProgress {
  return {
    phase: "analyzing-reviews",
    rowsCompleted: 5,
    rowsTotal: 10,
    batchesCompleted: 2,
    ...over,
  };
}

describe("phase ordering", () => {
  it("declares the four phases in the only order they occur", () => {
    expect(PHASE_ORDER).toEqual([
      "preparing",
      "analyzing-reviews",
      "grouping-themes",
      "building-report",
    ]);
  });

  it("gives every phase a position", () => {
    for (const phase of PHASE_ORDER) expect(phaseIndex(phase)).toBeGreaterThanOrEqual(0);
  });
});

describe("isProgressAdvance", () => {
  it("accepts the first update of a run", () => {
    expect(isProgressAdvance(null, progress())).toBe(true);
  });

  it("accepts more rows within the same phase", () => {
    expect(isProgressAdvance(progress({ rowsCompleted: 5 }), progress({ rowsCompleted: 6 }))).toBe(
      true,
    );
  });

  it("accepts the same row count within the same phase", () => {
    // Not an advance, but not a regression either — re-rendering the same
    // number is harmless, and refusing it would drop legitimate updates that
    // only changed the batch count.
    expect(isProgressAdvance(progress({ rowsCompleted: 5 }), progress({ rowsCompleted: 5 }))).toBe(
      true,
    );
  });

  it("rejects fewer rows within the same phase", () => {
    expect(isProgressAdvance(progress({ rowsCompleted: 6 }), progress({ rowsCompleted: 5 }))).toBe(
      false,
    );
  });

  it("accepts a later phase even when its row count is lower", () => {
    // A stage change is the strongest evidence of progress there is, and the
    // row count it reports is about a different thing.
    expect(
      isProgressAdvance(
        progress({ phase: "analyzing-reviews", rowsCompleted: 10 }),
        progress({ phase: "grouping-themes", rowsCompleted: 0 }),
      ),
    ).toBe(true);
  });

  it("rejects an earlier phase however many rows it claims", () => {
    expect(
      isProgressAdvance(
        progress({ phase: "grouping-themes", rowsCompleted: 0 }),
        progress({ phase: "analyzing-reviews", rowsCompleted: 10 }),
      ),
    ).toBe(false);
  });

  it.each([
    ["preparing", "analyzing-reviews"],
    ["analyzing-reviews", "grouping-themes"],
    ["grouping-themes", "building-report"],
  ] as const)("accepts the %s → %s transition", (from, to) => {
    expect(isProgressAdvance(progress({ phase: from }), progress({ phase: to }))).toBe(true);
  });

  it("rejects an update for a different selection", () => {
    // A changed total means this belongs to another run entirely; rendering it
    // would put one run's numbers under another run's heading.
    expect(isProgressAdvance(progress({ rowsTotal: 10 }), progress({ rowsTotal: 20 }))).toBe(false);
  });

  it.each([
    ["a negative row count", { rowsCompleted: -1 }],
    ["more rows than exist", { rowsCompleted: 11 }],
  ])("rejects %s", (_name, over) => {
    expect(isProgressAdvance(null, progress(over))).toBe(false);
  });

  it("rejects an unrecognised phase", () => {
    expect(isProgressAdvance(null, progress({ phase: "finishing-up" as never }))).toBe(false);
  });

  it("is monotonic over a whole realistic run", () => {
    const updates: AnalysisProgress[] = [
      { phase: "preparing", rowsCompleted: 0, rowsTotal: 10, batchesCompleted: 0 },
      { phase: "analyzing-reviews", rowsCompleted: 3, rowsTotal: 10, batchesCompleted: 1 },
      { phase: "analyzing-reviews", rowsCompleted: 7, rowsTotal: 10, batchesCompleted: 2 },
      { phase: "analyzing-reviews", rowsCompleted: 10, rowsTotal: 10, batchesCompleted: 4 },
      { phase: "grouping-themes", rowsCompleted: 10, rowsTotal: 10, batchesCompleted: 4 },
      { phase: "building-report", rowsCompleted: 10, rowsTotal: 10, batchesCompleted: 4 },
    ];
    let previous: AnalysisProgress | null = null;
    for (const update of updates) {
      expect(isProgressAdvance(previous, update), `${update.phase}@${update.rowsCompleted}`).toBe(
        true,
      );
      previous = update;
    }
  });
});
