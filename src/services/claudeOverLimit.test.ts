import { describe, it, expect, vi, afterEach } from "vitest";
import type { AnalysisInput, Dataset, Product, Review } from "../types";
import { analyzeWithClaude } from "./claudeEngine";
import { AnalysisError } from "./analysisEngine";
import { SYNC_OUTPUT_TOKEN_BUDGET, fitsSyncBudget } from "./claudeTags";

/**
 * A whole category can exceed what one synchronous request can finish where a
 * single product does not — three of the nine top-level categories in the real
 * Amazon dataset hold 447-526 records each. The engine must refuse clearly
 * rather than truncate, and must not spend a request finding out.
 *
 * The limit checked here is the engine's synchronous CAPABILITY, not the
 * endpoint's 100-row safety cap. Those were conflated before: a 30-row
 * selection passed the cap check and then timed out. These tests deliberately
 * use a size that is well under 100 rows and still over budget, so they fail if
 * the two are ever collapsed back into one number.
 */

const OVER = 40;

function bigCategory(source: Dataset["source"], productCount = 3): Dataset {
  const products: Product[] = Array.from({ length: productCount }, (_, i) => ({
    id: `p${i}`,
    name: `Product ${i}`,
    category: "Widgets",
    topCategory: "Electronics",
  }));
  const reviews: Review[] = Array.from({ length: OVER }, (_, i) => ({
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

function mockFetch() {
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

describe("Claude engine — a category over the cap", () => {
  it("refuses with a controlled AnalysisError rather than a partial result", async () => {
    mockFetch();
    await expect(analyzeWithClaude(categoryInput, bigCategory("uploaded"))).rejects.toBeInstanceOf(
      AnalysisError,
    );
  });

  // The whole point of refusing: a truncated answer would look like a complete
  // one, which is the failure mode this project treats as worse than an error.
  it("never sends the request, so nothing is truncated and no credit is spent", async () => {
    const fetchMock = mockFetch();
    await expect(analyzeWithClaude(categoryInput, bigCategory("uploaded"))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the subject, the real count and how far over budget it is", async () => {
    mockFetch();
    const message = await messageFrom(analyzeWithClaude(categoryInput, bigCategory("uploaded")));
    expect(message).toContain(`Electronics has ${OVER} reviews`);
    expect(message).toMatch(/\d+x more than the Claude\s+engine can analyze in one pass/);
  });

  // The regression this whole change exists to prevent.
  it("refuses a selection far under the endpoint's 100-row cap but over budget", async () => {
    const fetchMock = mockFetch();
    expect(OVER).toBeLessThan(100);              // the old check would have allowed this
    await expect(analyzeWithClaude(categoryInput, bigCategory("uploaded"))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();    // and it would have timed out 30s later
  });

  it("never quotes a fixed row cap it cannot honour", async () => {
    mockFetch();
    const message = await messageFrom(analyzeWithClaude(categoryInput, bigCategory("uploaded")));
    expect(message).not.toMatch(/at most \d+/);
    expect(message).not.toContain("100");
  });

  it("uses the dataset's own noun, not a hardcoded 'reviews'", async () => {
    mockFetch();
    await expect(analyzeWithClaude(categoryInput, bigCategory("amazon"))).rejects.toThrow(
      /product records/,
    );
  });

  // Advice has to be followable. Undated data has no window to narrow, so
  // offering that would send the analyst after a control that is not on screen.
  // Advice has to be followable. Undated data has no window to narrow, so
  // offering that would send the analyst after a control that is not on screen.
  // Asserted on the captured message rather than with `.rejects.not.toThrow`,
  // which passes as soon as the promise rejects and would prove nothing here.
  it("offers only remedies that exist for the query", async () => {
    mockFetch();
    const undatedMessage = await messageFrom(analyzeWithClaude(categoryInput, bigCategory("uploaded")));
    expect(undatedMessage).toContain("analyze a single product instead");
    expect(undatedMessage).not.toContain("narrow the date range");

    const base = bigCategory("uploaded");
    const dated: Dataset = { ...base, reviews: base.reviews.map((r) => ({ ...r, date: "2026-02-01" })) };
    const datedMessage = await messageFrom(
      analyzeWithClaude({ ...categoryInput, from: "2026-01-01", to: "2026-12-31" }, dated),
    );
    expect(datedMessage).toContain("narrow the date range");
  });

  it("always offers the heuristic engine, which has no cap", async () => {
    mockFetch();
    await expect(analyzeWithClaude(categoryInput, bigCategory("uploaded"))).rejects.toThrow(
      /heuristic engine, which has no limit/,
    );
  });
});

describe("Claude engine — within the synchronous budget", () => {
  it("sends the request for a selection that fits", async () => {
    const fetchMock = vi.fn(
      () =>
        new Response(JSON.stringify({ tags: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const dataset = bigCategory("uploaded");
    // Small enough to finish: the estimator must agree before we assert on it,
    // so this stays true if the budget is ever retuned.
    const rows = dataset.reviews.slice(0, 5);
    const bytes = rows.reduce((n, r) => n + new TextEncoder().encode(r.text).length, 0);
    expect(fitsSyncBudget(rows.length, bytes)).toBe(true);

    await analyzeWithClaude(categoryInput, { ...dataset, reviews: rows });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the budget below what the 30s wall admits at measured throughput", () => {
    // ~110 output tok/s measured x 30s ~= 3,300 tokens. The budget must leave
    // real headroom under that, or the guard is decorative.
    expect(SYNC_OUTPUT_TOKEN_BUDGET).toBeLessThan(3300 * 0.8);
  });
});
