import { describe, it, expect, vi, afterEach } from "vitest";
import type { AnalysisInput, Dataset } from "../types";
import { analyzeWithClaude } from "./claudeEngine";
import { AnalysisError } from "./analysisEngine";
import { MAX_ROWS_PER_BATCH_REQUEST } from "./claudeTags";
import { ceilingRefusalMessage, estimateRun, maxRowsPerAnalysis } from "./runEstimator";
import { RUN_ENVIRONMENT } from "../config";
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
  const OVER_CEILING = maxRowsPerAnalysis(RUN_ENVIRONMENT) + 1;

  it("does not quote the per-request row limit when refusing an oversized selection", async () => {
    const message = await refusalMessage(OVER_CEILING, 400);
    expect(message).not.toContain(String(MAX_ROWS_PER_BATCH_REQUEST));
    expect(message).not.toMatch(/batch/i);
    expect(message).not.toMatch(/per request|per-request/i);
  });

  it("refuses in product terms, not as a protocol error", async () => {
    const message = await refusalMessage(OVER_CEILING, 100);
    expect(message).not.toMatch(/batch|chunk|hierarch/i);
    expect(message).not.toMatch(/run id|runid/i);
    expect(message).toMatch(/heuristic engine/);
  });

  it("no longer refuses a selection merely for exceeding one request", async () => {
    // The behaviour this PR replaced. A selection just over the per-request
    // limit used to be refused; it is now split across requests and analyzed,
    // so there is no copy to leak in the first place.
    const rowCount = MAX_ROWS_PER_BATCH_REQUEST + 1;
    expect(rowCount).toBeLessThan(maxRowsPerAnalysis(RUN_ENVIRONMENT));

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { reviews: { id: string }[] };
      return new Response(
        JSON.stringify({
          tags: body.reviews.map((r) => ({
            review_id: r.id,
            theme: "Sound quality",
            sentiment: "praise",
            evidence_span: "x",
          })),
          usage: { inputTokens: 10, outputTokens: body.reviews.length * 40 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeWithClaude(input, dataset(rowCount, 100));
    expect(result.reviewCount).toBe(rowCount);
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
