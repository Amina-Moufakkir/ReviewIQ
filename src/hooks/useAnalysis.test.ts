import { describe, it, expect } from "vitest";
import { isSameQuery, stateForQuery, type AnalysisState } from "./useAnalysis";
import type { AnalysisInput, AnalysisResult } from "../types";

const query = (productId: string, from = "", to = ""): AnalysisInput => ({
  scope: { kind: "product", productId },
  from,
  to,
});

function resultFor(productName: string, reviewCount = 3): AnalysisResult {
  return {
    productName,
    from: "",
    to: "",
    reviewCount,
    averageRating: 4,
    summary: `Across ${reviewCount} reviews of ${productName}…`,
    praise: [],
    faults: [],
    recommendations: [],
  };
}

describe("isSameQuery", () => {
  it("compares every field that selects reviews", () => {
    expect(isSameQuery(query("a"), query("a"))).toBe(true);
    expect(isSameQuery(query("a"), query("b"))).toBe(false);
    expect(isSameQuery(query("a", "2026-01-01", "2026-06-01"), query("a", "2026-02-01", "2026-06-01"))).toBe(false);
    expect(isSameQuery(query("a", "2026-01-01", "2026-06-01"), query("a", "2026-01-01", "2026-07-01"))).toBe(false);
    expect(
      isSameQuery(query("a", "2026-01-01", "2026-06-01"), query("a", "2026-01-01", "2026-06-01")),
    ).toBe(true);
  });
});

/**
 * The reported bug, as a state machine: analyze product A, switch the selector
 * to product B, and A's report must not remain on screen under B's query.
 */
describe("stale results — the product-switch flow", () => {
  const productA = query("aurora-earbuds");
  const productB = query("trailpeak-backpack");
  const successA: AnalysisState = { status: "success", result: resultFor("AuroraSound Earbuds") };

  it("1. shows product A's result while product A is selected", () => {
    const visible = stateForQuery(successA, productA, productA);
    expect(visible).toBe(successA);
    expect(visible.status === "success" && visible.result.productName).toBe("AuroraSound Earbuds");
  });

  it("2. hides product A's result the moment product B is selected", () => {
    const visible = stateForQuery(successA, productA, productB);
    expect(visible).toEqual({ status: "idle" });
    expect(visible.status).not.toBe("success");
  });

  it("3. does not analyze product B on its own — it stays idle until asked", () => {
    // No new state is produced by selecting; the analyzed query is still A's.
    let visible = stateForQuery(successA, productA, productB);
    expect(visible).toEqual({ status: "idle" });
    // Re-rendering changes nothing: still idle, still no result for B.
    visible = stateForQuery(successA, productA, productB);
    expect(visible).toEqual({ status: "idle" });
  });

  it("4. shows product B's result once Run analysis is clicked", () => {
    // Running analysis records B as the analyzed query and produces B's result.
    const successB: AnalysisState = { status: "success", result: resultFor("TrailPeak Backpack") };
    const visible = stateForQuery(successB, productB, productB);
    expect(visible).toBe(successB);
    expect(visible.status === "success" && visible.result.productName).toBe("TrailPeak Backpack");
  });

  it("shows product A's result again if the analyst switches back", () => {
    // The result was never destroyed, only hidden while it did not apply.
    expect(stateForQuery(successA, productA, productA)).toBe(successA);
  });
});

describe("stateForQuery — which changes invalidate a result", () => {
  const analyzed = query("p1", "2026-01-01", "2026-06-01");
  const success: AnalysisState = { status: "success", result: resultFor("Widget") };

  it("invalidates on a product change", () => {
    expect(stateForQuery(success, analyzed, query("p2", "2026-01-01", "2026-06-01"))).toEqual({
      status: "idle",
    });
  });

  it("invalidates on a start-date change", () => {
    expect(stateForQuery(success, analyzed, query("p1", "2026-03-01", "2026-06-01"))).toEqual({
      status: "idle",
    });
  });

  it("invalidates on an end-date change", () => {
    expect(stateForQuery(success, analyzed, query("p1", "2026-01-01", "2026-05-01"))).toEqual({
      status: "idle",
    });
  });

  it("keeps the result when the query is unchanged", () => {
    expect(stateForQuery(success, analyzed, query("p1", "2026-01-01", "2026-06-01"))).toBe(success);
  });

  it("keeps the result across an unrelated re-render with an equal query object", () => {
    // A new object with the same values must not clear anything — this is what
    // stops results vanishing on every keystroke elsewhere in the UI.
    const equivalent: AnalysisInput = {
      scope: { kind: "product", productId: "p1" },
      from: "2026-01-01",
      to: "2026-06-01",
    };
    expect(stateForQuery(success, analyzed, equivalent)).toBe(success);
  });
});

describe("stateForQuery — other states", () => {
  const analyzed = query("p1");
  const other = query("p2");

  it("hides an empty result that belongs to another query", () => {
    const empty: AnalysisState = { status: "empty", result: resultFor("Widget", 0) };
    expect(stateForQuery(empty, analyzed, analyzed)).toBe(empty);
    expect(stateForQuery(empty, analyzed, other)).toEqual({ status: "idle" });
  });

  it("clears a query-bound error when the query changes", () => {
    // Messages like "Unknown product" or "narrow the date range" describe the
    // query that failed, so they must not outlive it.
    const error: AnalysisState = { status: "error", message: "The analysis timed out." };
    expect(stateForQuery(error, analyzed, analyzed)).toBe(error);
    expect(stateForQuery(error, analyzed, other)).toEqual({ status: "idle" });
  });

  it("drops the spinner for a run the analyst has already navigated away from", () => {
    const loading: AnalysisState = { status: "loading" };
    expect(stateForQuery(loading, analyzed, analyzed)).toBe(loading);
    expect(stateForQuery(loading, analyzed, other)).toEqual({ status: "idle" });
  });

  it("stays idle when nothing has been analyzed yet", () => {
    const idle: AnalysisState = { status: "idle" };
    expect(stateForQuery(idle, null, analyzed)).toBe(idle);
  });

  it("hides any result recorded without a query", () => {
    // Defensive: reset() clears the analyzed query, so nothing can outlive it.
    expect(stateForQuery({ status: "success", result: resultFor("Widget") }, null, analyzed)).toEqual({
      status: "idle",
    });
  });
});
