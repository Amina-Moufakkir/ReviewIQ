import { describe, it, expect } from "vitest";
import type { AnalysisInput, Dataset, Product, Review } from "../types";
import { planClaudeRun } from "./claudeRunPlan";
import { maxRowsPerAnalysis, ENVIRONMENT_CEILINGS, estimateRun } from "./runEstimator";
import { RUN_ENVIRONMENT } from "../config";

/**
 * One planner, shared by the confirmation dialog and the engine's own preflight.
 *
 * The point is that there is no second opinion. A run the dialog offers must be
 * one the engine would accept, and a refusal must read identically whichever of
 * them noticed — otherwise an analyst can be shown a Start button for a run
 * that then refuses itself, which is worse than either outcome alone.
 */

const CEILING = maxRowsPerAnalysis(RUN_ENVIRONMENT);

function dataset(rowCount: number, textLength = 40): Dataset {
  const products: Product[] = [
    { id: "p1", name: "Widget", category: "Widgets", topCategory: "Electronics" },
  ];
  const reviews: Review[] = Array.from({ length: rowCount }, (_, i) => ({
    id: `r${i}`,
    productId: "p1",
    date: "",
    rating: 4,
    text: `Row ${i}: ${"sound quality is good. ".repeat(Math.max(1, Math.round(textLength / 22)))}`,
  }));
  return { source: "uploaded", label: "x.csv", products, reviews };
}

const productInput: AnalysisInput = {
  scope: { kind: "product", productId: "p1" },
  from: "",
  to: "",
};
const categoryInput: AnalysisInput = {
  scope: { kind: "category", category: "Electronics" },
  from: "",
  to: "",
};

describe("planClaudeRun decisions", () => {
  it("reports an empty selection without refusing or pricing it", () => {
    const outcome = planClaudeRun(productInput, dataset(0));
    expect(outcome.decision).toBe("empty");
  });

  it("starts a small selection immediately", () => {
    const outcome = planClaudeRun(productInput, dataset(2, 20));
    expect(outcome.decision).toBe("go");
  });

  it("refuses a selection over the total-run ceiling", () => {
    const outcome = planClaudeRun(categoryInput, dataset(CEILING + 1));
    expect(outcome.decision).toBe("refuse");
    if (outcome.decision !== "refuse") throw new Error("unreachable");
    expect(outcome.message).toContain(String(CEILING));
  });

  it("asks before a selection that costs more than the environment allows unasked", () => {
    // Derived from the threshold, not hardcoded: retuning confirmAboveUsd must
    // move this test rather than silently invalidate it.
    const threshold = ENVIRONMENT_CEILINGS[RUN_ENVIRONMENT].confirmAboveUsd;
    const outcome = planClaudeRun(categoryInput, dataset(CEILING));
    expect(outcome.plan.estimate.cost.totalUsd).toBeGreaterThan(threshold);
    expect(outcome.decision).toBe("confirm");
  });

  it("carries the estimate the dialog needs to show", () => {
    const outcome = planClaudeRun(categoryInput, dataset(CEILING));
    const { estimate, matched, unit } = outcome.plan;

    expect(matched).toHaveLength(CEILING);
    expect(unit.many).toBe("reviews");
    expect(estimate.projectedBatchCount).toBeGreaterThan(0);
    expect(estimate.runtime.lowMs).toBeGreaterThan(0);
    expect(estimate.runtime.highMs).toBeGreaterThanOrEqual(estimate.runtime.lowMs);
    expect(estimate.cost.totalUsd).toBeGreaterThan(0);
  });

  it("checks the ceiling before the cost, so an impossible run is never priced for approval", () => {
    // Both conditions hold for this selection. Asking "will you pay for this?"
    // about a run that cannot be attempted is a question with no right answer.
    const outcome = planClaudeRun(categoryInput, dataset(CEILING + 20));
    expect(outcome.plan.estimate.exceedsCeiling).toBe(true);
    expect(outcome.plan.estimate.requiresConfirmation).toBe(true);
    expect(outcome.decision).toBe("refuse");
  });
});

describe("the planner agrees with the estimator it wraps", () => {
  it("returns exactly the estimate estimateRun would produce", () => {
    const ds = dataset(20);
    const outcome = planClaudeRun(categoryInput, ds);
    const direct = estimateRun(
      ds.reviews.map((r) => ({ id: r.id, text: r.text })),
      RUN_ENVIRONMENT,
    );
    expect(outcome.plan.estimate).toEqual(direct);
  });

  it("selects exactly the rows the engine would analyze", () => {
    const ds = dataset(7);
    const outcome = planClaudeRun(categoryInput, ds);
    expect(outcome.plan.rows.map((r) => r.id)).toEqual(ds.reviews.map((r) => r.id));
    expect(outcome.plan.rows.every((r) => Object.keys(r).sort().join() === "id,text")).toBe(true);
  });
});

describe("refusal copy stays analyst-facing", () => {
  it.each([
    ["over the ceiling", () => planClaudeRun(categoryInput, dataset(CEILING + 1))],
  ])("names no internal mechanics when %s", (_name, run) => {
    const outcome = run();
    if (outcome.decision !== "refuse") throw new Error("expected a refusal");
    expect(outcome.message).not.toMatch(/batch|chunk|hierarch|retry budget|\/api\//i);
  });

  it("offers only remedies that exist for the query", () => {
    const undated = planClaudeRun(categoryInput, dataset(CEILING + 1));
    if (undated.decision !== "refuse") throw new Error("expected a refusal");
    expect(undated.message).toContain("analyze a single product instead");
    expect(undated.message).not.toContain("narrow the date range");

    const base = dataset(CEILING + 1);
    const dated: Dataset = {
      ...base,
      reviews: base.reviews.map((r) => ({ ...r, date: "2026-02-01" })),
    };
    const withWindow = planClaudeRun(
      { ...categoryInput, from: "2026-01-01", to: "2026-12-31" },
      dated,
    );
    if (withWindow.decision !== "refuse") throw new Error("expected a refusal");
    expect(withWindow.message).toContain("narrow the date range");
  });
});
