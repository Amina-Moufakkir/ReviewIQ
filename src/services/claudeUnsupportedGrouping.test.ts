import { describe, it, expect, vi, afterEach } from "vitest";
import type { AnalysisInput, Dataset, Product, Review } from "../types";
import { estimateRun, maxRowsPerAnalysis } from "./runEstimator";

/**
 * The deterministic preflight for a selection whose themes cannot be reconciled.
 *
 * When the projection says the label set will not reduce to a single grouping
 * request, the run cannot complete — and every tagging request it made along
 * the way would still be billed, then discarded, because reporting on
 * unreconciled labels would under-count every theme two requests happened to
 * name differently. So nothing is sent at all.
 *
 * This is not hypothetical: the three largest real Amazon categories (447-526
 * records) are all projected unsupported. It is also only reachable at LOCAL
 * scale — the protected demo's 60-row ceiling refuses such selections on size
 * first — which is why this file pins the environment rather than inheriting it.
 */
vi.mock("../config", () => ({
  ANALYSIS_ENGINE: "claude",
  RUN_ENVIRONMENT: "local",
  resolveRunEnvironment: (value: unknown) => (value === "local" ? "local" : "protected-demo"),
}));

const { analyzeWithClaude } = await import("./claudeEngine");
const { AnalysisError } = await import("./analysisEngine");

/** Dense records, in the shape and size range the real Amazon categories have. */
function unsupportedSelection(rowCount = 520): Dataset {
  const products: Product[] = [
    { id: "p0", name: "Product 0", category: "Widgets", topCategory: "Electronics" },
  ];
  const reviews: Review[] = Array.from({ length: rowCount }, (_, i) => ({
    id: `r${i}`,
    productId: "p0",
    date: "",
    rating: 4,
    text: `Record ${i}: ${"the housing cracked and the cable frayed near the connector. ".repeat(12)}`,
  }));
  return { source: "amazon", label: "big.csv", products, reviews };
}

const categoryInput: AnalysisInput = {
  scope: { kind: "category", category: "Electronics" },
  from: "",
  to: "",
};

function mockUnusedFetch() {
  const fn = vi.fn(() => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function messageFrom(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the analysis to be refused, but it resolved");
}

afterEach(() => vi.unstubAllGlobals());

describe("preflight refusal when themes cannot be reconciled", () => {
  it("is genuinely projected unsupported and under the ceiling, so the test is not vacuous", () => {
    const rows = unsupportedSelection().reviews.map((r) => ({ id: r.id, text: r.text }));
    const estimate = estimateRun(rows, "local");

    expect(estimate.canonicalization.unsupported).toBe(true);
    // Under the ceiling, so it is THIS refusal being exercised, not the size one.
    expect(estimate.exceedsCeiling).toBe(false);
    expect(rows.length).toBeLessThan(maxRowsPerAnalysis("local"));
  });

  it("refuses without sending a single request", async () => {
    const fetchMock = mockUnusedFetch();
    await expect(analyzeWithClaude(categoryInput, unsupportedSelection())).rejects.toBeInstanceOf(
      AnalysisError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains it without naming the grouping machinery", async () => {
    mockUnusedFetch();
    const message = await messageFrom(analyzeWithClaude(categoryInput, unsupportedSelection()));

    expect(message).toMatch(/too many different themes/i);
    expect(message).toMatch(/heuristic engine, which has no limit/);
    // An analyst never chooses how labels are grouped.
    expect(message).not.toMatch(/hierarch|canonicaliz|representative|chunk|batch|level/i);
    expect(message).not.toMatch(/run id|runid/i);
  });

  it("offers only remedies that exist for the query", async () => {
    mockUnusedFetch();
    const message = await messageFrom(analyzeWithClaude(categoryInput, unsupportedSelection()));

    expect(message).toContain("analyze a single product instead");
    expect(message).not.toContain("narrow the date range");
  });

  it("does not refuse a selection whose themes CAN be reconciled", async () => {
    // The guard must not become a blanket refusal for large selections.
    const dataset = unsupportedSelection(30);
    const rows = dataset.reviews.map((r) => ({ id: r.id, text: r.text }));
    expect(estimateRun(rows, "local").canonicalization.unsupported).toBe(false);

    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      if (String(url).includes("/api/canonicalize")) {
        const labels = body.labels as string[];
        return new Response(JSON.stringify({ groups: labels.map((_, i) => [i]) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const reviews = body.reviews as { id: string }[];
      return new Response(
        JSON.stringify({
          tags: reviews.map((r) => ({
            review_id: r.id,
            theme: "Build quality",
            sentiment: "fault",
            evidence_span: "the housing cracked",
          })),
          usage: { inputTokens: 100, outputTokens: reviews.length * 40 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeWithClaude(categoryInput, dataset);
    expect(result.reviewCount).toBe(30);
    expect(fetchMock).toHaveBeenCalled();
  });
});
