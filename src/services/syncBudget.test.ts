import { describe, it, expect } from "vitest";
import {
  estimateOutputTokens,
  withinEstimatedSyncBudget,
  MAX_ROWS_PER_BATCH_REQUEST,
  SYNC_OUTPUT_TOKEN_BUDGET,
} from "./claudeTags";
import { maxRowsPerAnalysis } from "./runEstimator";
import { DEFAULT_PLANNER_CONFIG } from "./batchPlanner";

/**
 * The synchronous budget is the app's answer to a measured limit, so it is
 * tested against the measurements themselves rather than against its own
 * arithmetic. Every case below is a real run recorded in bench/DECISION.md on
 * 2026-08-02; if the estimator or the budget is retuned so that it would have
 * mispredicted any of them, these fail.
 */
const MEASURED = [
  { label: "5 dense Amazon rows", rows: 5, bytes: 4851, completed: true },
  { label: "10 dense Amazon rows", rows: 10, bytes: 12129, completed: false },
  { label: "20 dense Amazon rows", rows: 20, bytes: 19604, completed: false },
  { label: "100 dense Amazon rows", rows: 100, bytes: 154044, completed: false },
  { label: "25 light synthetic rows", rows: 25, bytes: 2814, completed: false },
] as const;

describe("synchronous budget — checked against measured runs", () => {
  it.each(MEASURED)("predicts $label ($completed)", ({ rows, bytes, completed }) => {
    expect(withinEstimatedSyncBudget(rows, bytes)).toBe(completed);
  });

  // The 25-row synthetic run timed out having streamed ~8,000 characters,
  // roughly 3,400 output tokens. The estimator puts it at 3,372 — the single
  // closest check available that it models output volume rather than input size.
  it("estimates the timed-out synthetic run within 5% of its observed output", () => {
    const estimate = estimateOutputTokens(25, 2814);
    expect(Math.abs(estimate - 3400) / 3400).toBeLessThan(0.05);
  });

  it("is driven by output volume, not byte size", () => {
    // 25 light rows are a tenth the bytes of 5 dense rows, yet cannot finish:
    // a rule keyed on payload size would get this exactly backwards.
    expect(2814).toBeLessThan(4851);
    expect(withinEstimatedSyncBudget(5, 4851)).toBe(true);
    expect(withinEstimatedSyncBudget(25, 2814)).toBe(false);
  });

  it("leaves headroom under what the 30s wall admits at measured throughput", () => {
    // ~110 output tok/s x 30s ~= 3,300 tokens.
    expect(SYNC_OUTPUT_TOKEN_BUDGET).toBeLessThan(3300 * 0.8);
  });
});

describe("the three row limits are separate controls", () => {
  it("keeps the total-analysis ceiling far above what one request can finish", () => {
    // The capability limit is about ONE request. The analysis ceiling is about a
    // whole category run. If these ever converge, one has been mistaken for the
    // other and category analysis has quietly become single-request analysis.
    const largestCompletableRowCount = Array.from({ length: 100 }, (_, i) => i + 1)
      .filter((n) => withinEstimatedSyncBudget(n, 0))
      .pop()!;
    expect(largestCompletableRowCount).toBeLessThan(maxRowsPerAnalysis("protected-demo"));
    expect(largestCompletableRowCount).toBeLessThan(maxRowsPerAnalysis("local"));
  });

  it("refuses selections the total-analysis ceiling would happily admit", () => {
    // 40 rows is well under either analysis ceiling and still over what one
    // synchronous request can finish. That gap is the reason batching exists.
    expect(40).toBeLessThan(maxRowsPerAnalysis("protected-demo"));
    expect(withinEstimatedSyncBudget(40, 40 * 120)).toBe(false);
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
  });
});
