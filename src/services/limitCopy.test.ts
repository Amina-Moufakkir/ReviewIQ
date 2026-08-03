import { describe, it, expect, vi, afterEach } from "vitest";
import type { AnalysisInput, Dataset } from "../types";
import { analyzeWithClaude } from "./claudeEngine";
import { AnalysisError } from "./analysisEngine";
import { MAX_ROWS_PER_BATCH_REQUEST } from "./claudeTags";
import { ceilingRefusalMessage, estimateRun, maxRowsPerAnalysis } from "./runEstimator";
import { DEFAULT_PLANNER_CONFIG } from "./batchPlanner";

/**
 * The per-request batch limit is an internal contract between the orchestrator
 * and the endpoint. An analyst never chooses a batch size, so quoting that
 * number in user-facing copy would be advice they cannot act on — and it would
 * leak an implementation detail that changes whenever the planner is retuned.
 *
 * The ceilings an analyst CAN act on are different numbers: how large a category
 * they may submit, and how much one pass can finish.
 */

const dataset = (rowCount: number, textLength: number): Dataset => ({
  source: "uploaded",
  label: "big.csv",
  products: [{ id: "p1", name: "Widget", category: "Electronics", topCategory: "Electronics" }],
  reviews: Array.from({ length: rowCount }, (_, i) => ({
    id: `r${i}`,
    productId: "p1",
    date: "",
    rating: 4,
    text: "x".repeat(textLength),
  })),
});

const input: AnalysisInput = { scope: { kind: "product", productId: "p1" }, from: "", to: "" };

afterEach(() => vi.unstubAllGlobals());

async function refusalMessage(rowCount: number, textLength: number): Promise<string> {
  const fetchMock = vi.fn(() => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    await analyzeWithClaude(input, dataset(rowCount, textLength));
  } catch (err) {
    expect(fetchMock, "must refuse before spending a request").not.toHaveBeenCalled();
    return (err as AnalysisError).message;
  }
  throw new Error("expected the analysis to be refused");
}

describe("user-facing limit copy never exposes the internal batch limit", () => {
  it("does not quote the per-request row limit when refusing an over-budget selection", async () => {
    const message = await refusalMessage(40, 400);
    expect(message).not.toContain(String(MAX_ROWS_PER_BATCH_REQUEST));
    expect(message).not.toMatch(/batch/i);
    expect(message).not.toMatch(/per request|per-request/i);
  });

  it("does not quote it when refusing a light selection just over the batch limit", async () => {
    // The window this PR closed: light rows that pass the budget estimate but
    // exceed what one request may carry. The refusal must still read as product
    // guidance, not as a protocol error.
    const message = await refusalMessage(MAX_ROWS_PER_BATCH_REQUEST + 1, 100);
    expect(message).not.toContain(String(MAX_ROWS_PER_BATCH_REQUEST));
    expect(message).not.toMatch(/batch/i);
    expect(message).toMatch(/heuristic engine/);
  });

  it("keeps the ceiling refusal about the analysis ceiling, not the batch limit", () => {
    const estimate = estimateRun(
      Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, text: "x".repeat(300) })),
      "protected-demo",
    );
    const message = ceilingRefusalMessage(estimate);
    expect(message).toContain(String(maxRowsPerAnalysis("protected-demo")));
    expect(message).not.toContain(` ${MAX_ROWS_PER_BATCH_REQUEST} `);
    expect(message).not.toMatch(/batch/i);
  });

  it("keeps the three limits distinct so copy cannot accidentally quote the wrong one", () => {
    expect(MAX_ROWS_PER_BATCH_REQUEST).toBe(DEFAULT_PLANNER_CONFIG.maxRowsPerBatch);
    expect(MAX_ROWS_PER_BATCH_REQUEST).toBeLessThan(maxRowsPerAnalysis("protected-demo"));
    expect(maxRowsPerAnalysis("protected-demo")).toBeLessThan(maxRowsPerAnalysis("local"));
  });
});
