import { describe, it, expect, vi, afterEach } from "vitest";
import type { AnalysisInput, Dataset, Product, Review } from "../types";
import { analyzeWithClaude } from "./claudeEngine";
import { AnalysisError } from "./analysisEngine";
import { MAX_ROWS_PER_BATCH_REQUEST } from "./claudeTags";
import { maxRowsPerAnalysis } from "./runEstimator";
import { RUN_ENVIRONMENT } from "../config";

/**
 * The only client-side limit left, and what it is now about.
 *
 * It used to ask whether a selection could be finished in ONE request, and
 * refused a 40-row category on those grounds. Batching answered that question
 * differently: the pipeline splits the selection, so 40 rows is now simply
 * analyzed. What remains is the question an analyst can act on — how large a
 * selection this deployment permits at all.
 *
 * These tests therefore pin the opposite pair of behaviours to the ones they
 * replaced: a selection that once would have been refused must now RUN, and the
 * refusal must fire only above the total-run ceiling.
 */

const CEILING = maxRowsPerAnalysis(RUN_ENVIRONMENT);
const OVER = CEILING + 1;
/** Comfortably under the ceiling, and far over anything one request could finish. */
const UNDER = Math.min(CEILING - 1, 40);

function category(source: Dataset["source"], rowCount: number, productCount = 3): Dataset {
  const products: Product[] = Array.from({ length: productCount }, (_, i) => ({
    id: `p${i}`,
    name: `Product ${i}`,
    category: "Widgets",
    topCategory: "Electronics",
  }));
  const reviews: Review[] = Array.from({ length: rowCount }, (_, i) => ({
    id: `r${i}`,
    productId: `p${i % productCount}`,
    date: "",
    rating: 4,
    text: `Row ${i} mentions sound quality.`,
  }));
  return { source, label: "big.csv", products, reviews };
}

const categoryInput: AnalysisInput = {
  scope: { kind: "category", category: "Electronics" },
  from: "",
  to: "",
};

/** A fetch that tags every row identically, so grouping is skipped. */
function mockWorkingFetch() {
  const fn = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { reviews: { id: string }[] };
    return new Response(
      JSON.stringify({
        tags: body.reviews.map((r) => ({
          review_id: r.id,
          theme: "Sound quality",
          sentiment: "praise",
          evidence_span: "sound quality",
        })),
        usage: { inputTokens: 100, outputTokens: body.reviews.length * 40 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** A fetch that must never be called. */
function mockUnusedFetch() {
  const fn = vi.fn(() => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The message of a rejection, failing loudly if the promise resolves instead. */
async function messageFrom(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the analysis to be refused, but it resolved");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a selection over the total-run ceiling", () => {
  it("refuses with a controlled AnalysisError rather than a partial result", async () => {
    mockUnusedFetch();
    await expect(
      analyzeWithClaude(categoryInput, category("uploaded", OVER)),
    ).rejects.toBeInstanceOf(AnalysisError);
  });

  // The whole point of refusing: a truncated answer would look like a complete
  // one, which is the failure mode this project treats as worse than an error.
  it("sends nothing, so nothing is truncated and no credit is spent", async () => {
    const fetchMock = mockUnusedFetch();
    await expect(analyzeWithClaude(categoryInput, category("uploaded", OVER))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the real count and the ceiling it exceeded", async () => {
    mockUnusedFetch();
    const message = await messageFrom(
      analyzeWithClaude(categoryInput, category("uploaded", OVER)),
    );
    expect(message).toContain(String(OVER));
    expect(message).toContain(String(CEILING));
  });

  it("uses the dataset's own noun, not a hardcoded 'reviews'", async () => {
    mockUnusedFetch();
    await expect(analyzeWithClaude(categoryInput, category("amazon", OVER))).rejects.toThrow(
      /product records/,
    );
  });

  // Advice has to be followable. Undated data has no window to narrow, so
  // offering that would send the analyst after a control that is not on screen.
  // Asserted on the captured message rather than with `.rejects.not.toThrow`,
  // which passes as soon as the promise rejects and would prove nothing here.
  it("offers only remedies that exist for the query", async () => {
    mockUnusedFetch();
    const undated = await messageFrom(analyzeWithClaude(categoryInput, category("uploaded", OVER)));
    expect(undated).toContain("analyze a single product instead");
    expect(undated).not.toContain("narrow the date range");

    const base = category("uploaded", OVER);
    const dated: Dataset = {
      ...base,
      reviews: base.reviews.map((r) => ({ ...r, date: "2026-02-01" })),
    };
    const datedMessage = await messageFrom(
      analyzeWithClaude({ ...categoryInput, from: "2026-01-01", to: "2026-12-31" }, dated),
    );
    expect(datedMessage).toContain("narrow the date range");
  });

  it("always offers the heuristic engine, which has no ceiling", async () => {
    mockUnusedFetch();
    await expect(analyzeWithClaude(categoryInput, category("uploaded", OVER))).rejects.toThrow(
      /heuristic engine, which has no limit/,
    );
  });

  it("never leaks the internal request limit or batching language", async () => {
    mockUnusedFetch();
    const message = await messageFrom(
      analyzeWithClaude(categoryInput, category("uploaded", OVER)),
    );
    expect(message).not.toMatch(/batch|chunk|hierarch/i);
    expect(message).not.toMatch(/run id|runid/i);
    expect(message).not.toContain(` ${MAX_ROWS_PER_BATCH_REQUEST} `);
  });
});

describe("a selection under the ceiling now runs instead of being refused", () => {
  it("analyzes a selection that one request could never have finished", async () => {
    // The regression this whole PR exists to remove. Forty rows was refused
    // before batching, on the grounds that it could not finish in one request.
    // It is now split across several and completes.
    const fetchMock = mockWorkingFetch();
    expect(UNDER).toBeGreaterThan(MAX_ROWS_PER_BATCH_REQUEST);

    const result = await analyzeWithClaude(categoryInput, category("uploaded", UNDER));

    expect(result.reviewCount).toBe(UNDER);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("keeps every request within the server's per-request limit", async () => {
    const fetchMock = mockWorkingFetch();
    await analyzeWithClaude(categoryInput, category("uploaded", UNDER));

    for (const [url, init] of fetchMock.mock.calls) {
      if (!String(url).includes("/api/analyze")) continue;
      const body = JSON.parse((init as RequestInit).body as string) as { reviews: unknown[] };
      expect(body.reviews.length).toBeLessThanOrEqual(MAX_ROWS_PER_BATCH_REQUEST);
    }
  });

  it("covers every selected row exactly once across the requests", async () => {
    const fetchMock = mockWorkingFetch();
    await analyzeWithClaude(categoryInput, category("uploaded", UNDER));

    const sent: string[] = [];
    for (const [url, init] of fetchMock.mock.calls) {
      if (!String(url).includes("/api/analyze")) continue;
      const body = JSON.parse((init as RequestInit).body as string) as { reviews: { id: string }[] };
      sent.push(...body.reviews.map((r) => r.id));
    }
    expect(sent).toHaveLength(UNDER);
    expect(new Set(sent).size).toBe(UNDER);
  });

  it("accepts a selection exactly at the ceiling", async () => {
    mockWorkingFetch();
    const result = await analyzeWithClaude(categoryInput, category("uploaded", CEILING));
    expect(result.reviewCount).toBe(CEILING);
  });
});
