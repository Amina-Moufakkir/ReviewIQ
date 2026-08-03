import { describe, it, expect, vi, afterEach } from "vitest";
import type { AnalysisInput, Dataset } from "../types";
import { analyzeWithClaude } from "./claudeEngine";
import { AnalysisError } from "./analysisEngine";

const DATASET: Dataset = {
  source: "uploaded",
  label: "test.csv",
  products: [{ id: "p1", name: "Test Widget", category: "Electronics", topCategory: "Electronics" }],
  reviews: [
    { id: "r1", productId: "p1", date: "2026-02-01", rating: 5, text: "Very comfortable to wear." },
    { id: "r2", productId: "p1", date: "2026-02-02", rating: 4, text: "So comfortable for long days." },
    { id: "r3", productId: "p1", date: "2026-02-03", rating: 2, text: "Connection keeps dropping." },
  ],
};
const INPUT: AnalysisInput = {
  scope: { kind: "product", productId: "p1" },
  from: "2026-01-01",
  to: "2026-12-31",
};

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

interface WireTag {
  review_id: string;
  theme: string;
  sentiment: string;
  evidence_span: string;
}

/**
 * A fetch that answers each request with only the tags belonging to the rows it
 * was actually sent, and groups labels as singletons.
 *
 * Needed because the pipeline splits a selection across several requests: a
 * row-agnostic stub would return tags for rows a later batch never received,
 * which the client-side gate correctly rejects as an unknown review id. That
 * would be the stub failing, not the engine.
 */
function mockBatchedFetch(allTags: WireTag[]) {
  return mockFetch((url, init) => {
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    if (String(url).includes("/api/canonicalize")) {
      const labels = body.labels as string[];
      return jsonResponse({ groups: labels.map((_, i) => [i]) });
    }
    const ids = new Set((body.reviews as { id: string }[]).map((r) => r.id));
    const tags = allTags.filter((t) => ids.has(t.review_id));
    return jsonResponse({ tags, usage: { inputTokens: 100, outputTokens: ids.size * 40 } });
  });
}

/** Every row id sent to /api/analyze, across all requests, in order. */
function sentRowIds(fetchFn: ReturnType<typeof mockFetch>): string[] {
  return fetchFn.mock.calls
    .filter(([url]) => String(url).includes("/api/analyze"))
    .flatMap(([, init]) => {
      const body = JSON.parse((init as RequestInit).body as string) as { reviews: { id: string }[] };
      return body.reviews.map((r) => r.id);
    });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("analyzeWithClaude — success", () => {
  it("posts the filtered reviews to /api/analyze and builds a result from validated tags", async () => {
    const fetchFn = mockBatchedFetch([
      { review_id: "r1", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable to wear" },
      { review_id: "r2", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable for long days" },
    ]);

    const result = await analyzeWithClaude(INPUT, DATASET);

    // Every matched review reached the same-origin endpoint, exactly once —
    // across however many requests the planner chose to use.
    expect(sentRowIds(fetchFn)).toEqual(["r1", "r2", "r3"]);
    for (const [url] of fetchFn.mock.calls) {
      expect(["/api/analyze", "/api/canonicalize"]).toContain(String(url));
    }

    // Counts computed in TS from the tags.
    const comfort = result.praise.find((f) => f.label === "Comfort");
    expect(comfort?.mentions).toBe(2);
    expect(comfort?.percent).toBe(67); // 2 of 3 matched
  });

  it("does not call the network when the window has no matching reviews", async () => {
    const fetchFn = mockFetch(() => jsonResponse({ tags: [] }));
    const result = await analyzeWithClaude(
      { scope: { kind: "product", productId: "p1" }, from: "2020-01-01", to: "2020-12-31" },
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

describe("analyzeWithClaude — strict response integrity (second gate)", () => {
  it("throws when ALL server tags fail validation", async () => {
    mockFetch(() =>
      jsonResponse({
        tags: [
          { review_id: "ghost", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable to wear" },
          { review_id: "r1", theme: "Comfort", sentiment: "positive", evidence_span: "comfortable to wear" },
          { review_id: "r2", theme: "Comfort", sentiment: "praise", evidence_span: "text not in this review" },
        ],
      }),
    );
    await expect(analyzeWithClaude(INPUT, DATASET)).rejects.toBeInstanceOf(AnalysisError);
  });

  it("throws when ANY server tag fails validation (a trusted payload must be fully valid)", async () => {
    mockFetch(() =>
      jsonResponse({
        tags: [
          { review_id: "r1", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable to wear" }, // valid
          { review_id: "r2", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable for long days" }, // valid
          { review_id: "ghost", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable to wear" }, // invalid
        ],
      }),
    );
    // Strict: a single invalid tag from the trusted server fails the whole request
    // (server/client mismatch or defect) rather than silently keeping the valid two.
    await expect(analyzeWithClaude(INPUT, DATASET)).rejects.toBeInstanceOf(AnalysisError);
  });

  it("throws when the server returns a duplicate tag (server should have deduplicated)", async () => {
    mockFetch(() =>
      jsonResponse({
        tags: [
          { review_id: "r1", theme: "Comfort", sentiment: "praise", evidence_span: "Very comfortable to wear" },
          { review_id: "r1", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable to wear" }, // dup {id,theme,sentiment}
        ],
      }),
    );
    await expect(analyzeWithClaude(INPUT, DATASET)).rejects.toBeInstanceOf(AnalysisError);
  });

  it("treats a genuinely empty tag array as a legitimate empty result (no throw)", async () => {
    mockBatchedFetch([]);
    const result = await analyzeWithClaude(INPUT, DATASET);
    expect(result.reviewCount).toBe(3); // reviews were analyzed; Claude found no themes
    expect(result.praise).toHaveLength(0);
    expect(result.faults).toHaveLength(0);
  });

  it("treats valid-but-below-threshold tags as a legitimate empty result (no throw)", async () => {
    // One valid Comfort mention — below MIN_EVIDENCE, so no finding, but the
    // tag is valid, so this is NOT the all-rejected failure case.
    mockBatchedFetch([
      { review_id: "r1", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable to wear" },
    ]);
    const result = await analyzeWithClaude(INPUT, DATASET);
    expect(result.praise).toHaveLength(0);
    expect(result.faults).toHaveLength(0);
  });
});

describe("analyzeWithClaude — no result unless every stage succeeds", () => {
  /** Two distinct labels, so grouping is genuinely required rather than skipped. */
  const TWO_LABELS: WireTag[] = [
    { review_id: "r1", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable to wear" },
    { review_id: "r2", theme: "Fit", sentiment: "praise", evidence_span: "comfortable for long days" },
  ];

  /** Tagging succeeds; grouping answers however the test says. */
  function mockFetchWithGrouping(grouping: () => Response) {
    return mockFetch((url, init) => {
      if (String(url).includes("/api/canonicalize")) return grouping();
      const body = JSON.parse((init as RequestInit).body as string) as { reviews: { id: string }[] };
      const ids = new Set(body.reviews.map((r) => r.id));
      return jsonResponse({
        tags: TWO_LABELS.filter((t) => ids.has(t.review_id)),
        usage: { inputTokens: 100, outputTokens: ids.size * 40 },
      });
    });
  }

  it("throws rather than reporting on un-reconciled labels when grouping fails", async () => {
    // Tagging produced a complete, valid tag set. Reporting on it anyway would
    // under-count every theme two requests happened to name differently, and
    // would look exactly like a finished analysis.
    const fetchFn = mockFetchWithGrouping(() =>
      jsonResponse({ error: { code: "provider_unavailable" } }, 502),
    );

    await expect(analyzeWithClaude(INPUT, DATASET)).rejects.toBeInstanceOf(AnalysisError);
    // Grouping really was reached — this is not passing by failing earlier.
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes("/api/canonicalize"))).toBe(true);
  });

  it("throws when grouping returns something that is not a valid partition", async () => {
    mockFetchWithGrouping(() => jsonResponse({ groups: [[0]] })); // drops a label
    await expect(analyzeWithClaude(INPUT, DATASET)).rejects.toBeInstanceOf(AnalysisError);
  });

  it("throws when grouping is unreadable", async () => {
    mockFetchWithGrouping(() => new Response("not json", { status: 200 }));
    await expect(analyzeWithClaude(INPUT, DATASET)).rejects.toBeInstanceOf(AnalysisError);
  });

  it("aggregates onto the canonical label once grouping succeeds", async () => {
    // Both labels merge, so the two single-support themes become one theme with
    // two supporting reviews — which is the whole point of the stage.
    mockFetchWithGrouping(() => jsonResponse({ groups: [[0, 1]] }));

    const result = await analyzeWithClaude(INPUT, DATASET);
    expect(result.praise).toHaveLength(1);
    expect(result.praise[0]!.mentions).toBe(2);
    expect(["Comfort", "Fit"]).toContain(result.praise[0]!.label);
  });

  it("keeps them apart when grouping says they are different themes", async () => {
    mockFetchWithGrouping(() => jsonResponse({ groups: [[0], [1]] }));

    const result = await analyzeWithClaude(INPUT, DATASET);
    // One supporting review each — both below the evidence threshold.
    expect(result.praise).toHaveLength(0);
  });

  it("never leaks internal mechanics when a stage fails", async () => {
    mockFetchWithGrouping(() => jsonResponse({ error: { code: "provider_unavailable" } }, 502));
    try {
      await analyzeWithClaude(INPUT, DATASET);
      throw new Error("expected a refusal");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toMatch(/batch|chunk|hierarch/i);
      expect(message).not.toMatch(/run id|runid/i);
      expect(message).not.toMatch(/canonicaliz/i);
    }
  });
});

describe("analyzeWithClaude — controlled status mapping", () => {
  /** A response with no readable `{ error: { message } }` — e.g. an edge sign-in page. */
  function opaque(status: number): Response {
    return new Response("<!doctype html><title>Sign in</title>", {
      status,
      headers: { "content-type": "text/html" },
    });
  }

  async function messageFor(response: Response): Promise<string> {
    mockFetch(() => response);
    try {
      await analyzeWithClaude(INPUT, DATASET);
    } catch (err) {
      return (err as AnalysisError).message;
    }
    throw new Error("expected analyzeWithClaude to throw");
  }

  it("prefers the endpoint's own controlled message when there is one", async () => {
    const message = await messageFor(
      jsonResponse({ error: { code: "analysis_disabled", message: "AI analysis is temporarily unavailable." } }, 503),
    );
    expect(message).toBe("AI analysis is temporarily unavailable.");
  });

  it.each([401, 403])(
    "explains deployment protection on %i, which is blocked at the edge with no JSON body",
    async (status) => {
      const message = await messageFor(opaque(status));
      expect(message).toMatch(/requires sign-in/i);
    },
  );

  it("maps an opaque 503 to the disabled message", async () => {
    expect(await messageFor(opaque(503))).toMatch(/temporarily unavailable/i);
  });

  it("maps an opaque 429 to a busy message that invites a retry", async () => {
    expect(await messageFor(opaque(429))).toMatch(/busy/i);
  });

  it("maps an opaque 504 to a timeout message that suggests a smaller selection", async () => {
    const message = await messageFor(opaque(504));
    expect(message).toMatch(/timed out/i);
    expect(message).toMatch(/smaller selection/i);
  });

  it("maps an opaque 413 to over-limit guidance naming the heuristic engine", async () => {
    expect(await messageFor(opaque(413))).toMatch(/heuristic engine/i);
  });

  it("never surfaces a raw status code or provider wording to the analyst", async () => {
    for (const status of [401, 403, 429, 500, 502, 503, 504]) {
      const message = await messageFor(opaque(status));
      expect(message).not.toMatch(/\b(4\d{2}|5\d{2})\b/);
      expect(message).not.toMatch(/anthropic|api key|sk-ant/i);
    }
  });
});
