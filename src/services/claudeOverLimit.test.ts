import { describe, it, expect, vi, afterEach } from "vitest";
import type { AnalysisInput, Dataset, Product, Review } from "../types";
import { analyzeWithClaude } from "./claudeEngine";
import { AnalysisError } from "./analysisEngine";
import { MAX_REVIEWS_PER_REQUEST } from "./claudeTags";

/**
 * A whole category can exceed the endpoint's per-request cap where a single
 * product does not — three of the nine top-level categories in the real Amazon
 * dataset hold 447-526 records each. The engine must refuse clearly rather than
 * truncate, and must not spend a request finding out.
 */

const OVER = MAX_REVIEWS_PER_REQUEST + 1;

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

  it("names the subject, the real count and the cap", async () => {
    mockFetch();
    await expect(analyzeWithClaude(categoryInput, bigCategory("uploaded"))).rejects.toThrow(
      new RegExp(`Electronics has ${OVER} reviews.*at most ${MAX_REVIEWS_PER_REQUEST}`),
    );
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

describe("Claude engine — at or under the cap", () => {
  it("sends the request when the selection exactly fills the cap", async () => {
    const fetchMock = vi.fn(
      () =>
        new Response(JSON.stringify({ tags: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const dataset = bigCategory("uploaded");
    const atCap: Dataset = { ...dataset, reviews: dataset.reviews.slice(0, MAX_REVIEWS_PER_REQUEST) };

    await analyzeWithClaude(categoryInput, atCap);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
