// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { ConfirmRunDialog } from "./ConfirmRunDialog";
import type { PlannedRun } from "../services/claudeRunPlan";
import { PRODUCT_RECORD } from "../lib/datasetInfo";
import type { RunEstimate } from "../services/runEstimator";

/**
 * The dialog in isolation, where a double click can actually be delivered.
 *
 * Through the full app the state change to `running` unmounts this component
 * between clicks, so a second click lands on nothing and the test passes
 * whether or not the guard exists. Rendering it alone is what makes the guard
 * observable: both clicks reach the same live button, in the same tick, which
 * is exactly the case a real double-click produces.
 */

function estimate(over: Partial<RunEstimate> = {}): RunEstimate {
  return {
    environment: "protected-demo",
    rowCount: 40,
    textBytes: 40_000,
    projectedBatchCount: 14,
    conservativeBatchCount: 14,
    cost: { taggingUsd: 0.5, canonicalizationUsd: 0.02, retryAllowanceUsd: 0.05, totalUsd: 0.57 },
    runtime: { lowMs: 240_000, expectedMs: 400_000, highMs: 720_000 },
    canonicalization: {
      levels: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      unsupported: false,
    },
    requiresConfirmation: true,
    exceedsCeiling: false,
    ceiling: { maxRows: 60, confirmAboveUsd: 0.25 },
    ...over,
  } as RunEstimate;
}

function plan(over: Partial<PlannedRun> = {}): PlannedRun {
  return {
    subject: {
      id: "Computers&Accessories",
      name: "Computers&Accessories",
      category: "Computers&Accessories",
      topCategory: "Computers&Accessories",
    },
    matched: Array.from({ length: 40 }, (_, i) => ({
      id: `r${i}`,
      productId: "p1",
      date: "",
      rating: 4,
      text: "text",
    })),
    rows: Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, text: "text" })),
    unit: PRODUCT_RECORD,
    estimate: estimate(),
    ...over,
  };
}

afterEach(cleanup);

describe("ConfirmRunDialog", () => {
  it("starts exactly one run however many times Start is clicked", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmRunDialog plan={plan()} onConfirm={onConfirm} onCancel={vi.fn()} />);

    const start = screen.getByRole("button", { name: /start analysis/i });
    fireEvent.click(start);
    fireEvent.click(start);
    fireEvent.click(start);

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("still allows Cancel after Start has latched", () => {
    // The latch stops a second RUN, not the analyst's ability to back out of a
    // component that has not yet been replaced.
    const onCancel = vi.fn();
    render(<ConfirmRunDialog plan={plan()} onConfirm={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: /start analysis/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders the figures from the estimate rather than recomputing them", () => {
    render(
      <ConfirmRunDialog
        plan={plan({ estimate: estimate({ runtime: { lowMs: 240_000, expectedMs: 400_000, highMs: 720_000 } }) })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/Analyze 40 product records\?/i)).toBeTruthy();
    expect(screen.getByText(/4–12 minutes/)).toBeTruthy();
    expect(screen.getByText(/up to about \$0\.57/)).toBeTruthy();
    expect(screen.getByText("Computers&Accessories")).toBeTruthy();
  });

  it("states the all-or-nothing contract before any money is spent", () => {
    render(<ConfirmRunDialog plan={plan()} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(
      screen.getByText(/creates a report only if the full analysis completes and validates/i),
    ).toBeTruthy();
  });

  it("names no internal machinery", () => {
    render(<ConfirmRunDialog plan={plan()} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(document.body.textContent ?? "").not.toMatch(
      /\bbatch|\bchunk|hierarch|retry|endpoint|run id|runid|\/api\//i,
    );
  });
});
