import { describe, it, expect } from "vitest";
import {
  estimateOutputTokens,
  withinEstimatedSyncBudget,
  MAX_REVIEWS_PER_REQUEST,
  SYNC_OUTPUT_TOKEN_BUDGET,
} from "./claudeTags";

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

describe("the safety limit and the capability limit are different controls", () => {
  it("keeps the endpoint cap far above what one request can finish", () => {
    // If these ever converge, one of them has been mistaken for the other.
    const largestCompletableRowCount = Array.from({ length: 100 }, (_, i) => i + 1)
      .filter((n) => withinEstimatedSyncBudget(n, 0))
      .pop();
    expect(largestCompletableRowCount).toBeLessThan(MAX_REVIEWS_PER_REQUEST);
  });

  it("refuses selections the endpoint would happily accept", () => {
    // 40 rows is under the 100-row cap and over budget. This gap is the bug the
    // capability model exists to close, so it must stay non-empty.
    expect(40).toBeLessThan(MAX_REVIEWS_PER_REQUEST);
    expect(withinEstimatedSyncBudget(40, 40 * 120)).toBe(false);
  });
});
