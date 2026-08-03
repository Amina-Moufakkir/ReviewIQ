import { describe, it, expect } from "vitest";
import { estimateOutputTokens, MAX_ROWS_PER_BATCH_REQUEST } from "./claudeTags";
import { maxRowsPerAnalysis } from "./runEstimator";
import { DEFAULT_PLANNER_CONFIG } from "./batchPlanner";

/**
 * Historical regression evidence: the measurements that made batching necessary.
 *
 * These runs were real, against the real endpoint, on 2026-08-02
 * (bench/DECISION.md). They are the reason ReviewIQ does not send a category as
 * one request: five dense rows completed in ~19s, while ten dense rows, twenty
 * dense rows, and the ENTIRE 25-row synthetic demo category all hit the 30s wall
 * — the last of those at only 2,814 bytes of text.
 *
 * The gate they once fed (`withinEstimatedSyncBudget`) is gone: the pipeline
 * splits a selection into batches, so "does this fit in one request" no longer
 * decides anything an analyst sees. What survives is the estimator, which still
 * seeds the planner's density before any batch has been measured and still
 * projects cost and runtime before a run starts.
 *
 * So these assert the estimator against the observations directly, rather than
 * against its own arithmetic. If it is ever retuned such that it would have
 * mispredicted one of these runs, that is a regression against measured
 * reality, and it fails here.
 */

/** ~110 output tok/s sustained x a 30s provider timeout. */
const THIRTY_SECOND_OUTPUT_CEILING = 3300;

/** Every run recorded on 2026-08-02, with what actually happened. */
const MEASURED = [
  { label: "5 dense Amazon rows", rows: 5, bytes: 4851, completed: true },
  { label: "10 dense Amazon rows", rows: 10, bytes: 12129, completed: false },
  { label: "20 dense Amazon rows", rows: 20, bytes: 19604, completed: false },
  { label: "100 dense Amazon rows", rows: 100, bytes: 154044, completed: false },
  { label: "25 light synthetic rows", rows: 25, bytes: 2814, completed: false },
] as const;

describe("the estimator still agrees with every run that was measured", () => {
  it.each(MEASURED)(
    "puts $label on the correct side of the 30s wall (completed: $completed)",
    ({ rows, bytes, completed }) => {
      const estimated = estimateOutputTokens(rows, bytes);
      expect(estimated < THIRTY_SECOND_OUTPUT_CEILING).toBe(completed);
    },
  );

  it("estimates the timed-out synthetic run within 5% of its observed output", () => {
    // That run streamed ~8,000 characters before the wall, roughly 3,400 output
    // tokens. This is the single closest check available that the estimator
    // models output VOLUME rather than input size.
    const estimate = estimateOutputTokens(25, 2814);
    expect(Math.abs(estimate - 3400) / 3400).toBeLessThan(0.05);
  });

  it("is driven by output volume, not payload size", () => {
    // 25 light rows are a tenth the bytes of 5 dense rows and still could not
    // finish. A rule keyed on payload size would get this exactly backwards —
    // and so would a rule keyed on row count alone.
    expect(2814).toBeLessThan(4851);
    expect(estimateOutputTokens(5, 4851)).toBeLessThan(THIRTY_SECOND_OUTPUT_CEILING);
    expect(estimateOutputTokens(25, 2814)).toBeGreaterThan(THIRTY_SECOND_OUTPUT_CEILING);
  });
});

describe("why one request could never reach category scale", () => {
  it("shows the complete synthetic demo category exceeding a single request", () => {
    // The demo dataset is 25 rows. This is the failure batching was built for:
    // not an unreasonable selection, the smallest complete one there is.
    expect(estimateOutputTokens(25, 2814)).toBeGreaterThan(THIRTY_SECOND_OUTPUT_CEILING);
  });

  it("shows a real Amazon category exceeding it by orders of magnitude", () => {
    // 526 rows at the measured dense density. The model's own output ceiling is
    // 128k tokens, so this was never a matter of a longer timeout.
    const denseBytesPerRow = 970;
    expect(estimateOutputTokens(526, 526 * denseBytesPerRow)).toBeGreaterThan(128_000);
  });
});

describe("the three row limits remain separate controls", () => {
  it("keeps the analysis ceiling far above what one request could ever finish", () => {
    // What one request can finish is about a REQUEST. The analysis ceiling is
    // about a whole category run. If these ever converge, one has been mistaken
    // for the other and category analysis has quietly become single-request
    // analysis again.
    const largestSingleRequestRowCount = Array.from({ length: 100 }, (_, i) => i + 1)
      .filter((n) => estimateOutputTokens(n, 0) < THIRTY_SECOND_OUTPUT_CEILING)
      .pop()!;
    expect(largestSingleRequestRowCount).toBeLessThan(maxRowsPerAnalysis("protected-demo"));
    expect(largestSingleRequestRowCount).toBeLessThan(maxRowsPerAnalysis("local"));
  });

  it("admits selections that one request could not have finished", () => {
    // 40 rows is well under either analysis ceiling and over what one request
    // could complete. That gap is precisely what batching exists to close, so
    // the ceiling must not have been quietly lowered to avoid it.
    expect(40).toBeLessThan(maxRowsPerAnalysis("protected-demo"));
    expect(estimateOutputTokens(40, 40 * 120)).toBeGreaterThan(THIRTY_SECOND_OUTPUT_CEILING);
  });

  it("does not conflate the per-request limit with the analysis ceiling", () => {
    // The endpoint takes one batch; the ceiling governs a whole run. The batch
    // limit must be far the smaller of the two, or the endpoint has silently
    // become the thing that bounds an analysis.
    expect(MAX_ROWS_PER_BATCH_REQUEST).toBeLessThan(maxRowsPerAnalysis("protected-demo"));
    expect(MAX_ROWS_PER_BATCH_REQUEST).toBeLessThan(maxRowsPerAnalysis("local"));
    expect(maxRowsPerAnalysis("protected-demo")).not.toBe(MAX_ROWS_PER_BATCH_REQUEST);
  });

  it("pins the per-request limit to the planner's batch ceiling, with no slack", () => {
    // Deliberately equal. A margin would be hidden coupling: a planner retune
    // would start relying on it silently. Changing one must change the other,
    // and this test is what forces that to be a decision.
    expect(MAX_ROWS_PER_BATCH_REQUEST).toBe(DEFAULT_PLANNER_CONFIG.maxRowsPerBatch);
    expect(MAX_ROWS_PER_BATCH_REQUEST).toBe(12);
  });
});
