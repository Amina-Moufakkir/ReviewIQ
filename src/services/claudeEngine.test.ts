import { describe, it, expect, vi, afterEach } from "vitest";
import type { Dataset } from "../types";
import { analyzeWithClaude } from "./claudeEngine";
import { AnalysisError } from "./analysisEngine";

const DATASET: Dataset = {
  source: "uploaded",
  label: "test.csv",
  products: [{ id: "p1", name: "Test Widget", category: "Electronics" }],
  reviews: [
    { id: "r1", productId: "p1", date: "2026-02-01", rating: 5, text: "Very comfortable to wear." },
    { id: "r2", productId: "p1", date: "2026-02-02", rating: 4, text: "So comfortable for long days." },
    { id: "r3", productId: "p1", date: "2026-02-03", rating: 2, text: "Connection keeps dropping." },
  ],
};
const INPUT = { productId: "p1", from: "2026-01-01", to: "2026-12-31" };

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("analyzeWithClaude — success", () => {
  it("posts the filtered reviews to /api/analyze and builds a result from validated tags", async () => {
    const fetchFn = mockFetch(() =>
      jsonResponse({
        tags: [
          { review_id: "r1", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable to wear" },
          { review_id: "r2", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable for long days" },
        ],
      }),
    );

    const result = await analyzeWithClaude(INPUT, DATASET);

    // Called the same-origin endpoint with the matched reviews.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("/api/analyze");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.reviews.map((r: { id: string }) => r.id)).toEqual(["r1", "r2", "r3"]);

    // Counts computed in TS from the tags.
    const comfort = result.praise.find((f) => f.label === "Comfort");
    expect(comfort?.mentions).toBe(2);
    expect(comfort?.percent).toBe(67); // 2 of 3 matched
  });

  it("does not call the network when the window has no matching reviews", async () => {
    const fetchFn = mockFetch(() => jsonResponse({ tags: [] }));
    const result = await analyzeWithClaude(
      { productId: "p1", from: "2020-01-01", to: "2020-12-31" },
      DATASET,
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.reviewCount).toBe(0);
  });
});

describe("analyzeWithClaude — failures never fall back to the heuristic engine", () => {
  it("throws AnalysisError when the network request fails", async () => {
    mockFetch(() => Promise.reject(new Error("network down")));
    await expect(analyzeWithClaude(INPUT, DATASET)).rejects.toBeInstanceOf(AnalysisError);
  });

  it("throws AnalysisError on a non-2xx endpoint response", async () => {
    mockFetch(() => jsonResponse({ error: { code: "analysis_failed", message: "boom" } }, 502));
    await expect(analyzeWithClaude(INPUT, DATASET)).rejects.toBeInstanceOf(AnalysisError);
  });

  it("throws AnalysisError when the endpoint returns unreadable (non-JSON) output", async () => {
    mockFetch(() => new Response("not json", { status: 200 }));
    await expect(analyzeWithClaude(INPUT, DATASET)).rejects.toBeInstanceOf(AnalysisError);
  });

  it("throws AnalysisError when the payload shape is unexpected", async () => {
    mockFetch(() => jsonResponse({ notTags: [] }));
    await expect(analyzeWithClaude(INPUT, DATASET)).rejects.toBeInstanceOf(AnalysisError);
  });
});

describe("analyzeWithClaude — defensive re-validation (second gate)", () => {
  it("discards malformed tags so they never surface as findings", async () => {
    mockFetch(() =>
      jsonResponse({
        tags: [
          { review_id: "ghost", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable to wear" },
          { review_id: "r1", theme: "Comfort", sentiment: "positive", evidence_span: "comfortable to wear" },
          { review_id: "r2", theme: "Comfort", sentiment: "praise", evidence_span: "text not in this review" },
        ],
      }),
    );
    const result = await analyzeWithClaude(INPUT, DATASET);
    // All three entries are invalid (unknown id / bad sentiment / bad evidence).
    expect(result.praise).toHaveLength(0);
    expect(result.faults).toHaveLength(0);
  });
});
