import { describe, it, expect } from "vitest";
import type { Review } from "../types";
import { analyze, filterReviews, reviewStatsFor, AnalysisError } from "./analysisEngine";

const PRODUCT = "aurora-earbuds";

// Small, controlled fixtures. Text is written so keywords land on the intended
// themes: "sound"/"battery"/"comfortable" (positive), "connection"/"bluetooth"
// (Connectivity, negative).
function review(partial: Partial<Review> & Pick<Review, "id" | "date" | "rating" | "text">): Review {
  return {
    productId: PRODUCT,
    author: `Author ${partial.id}`,
    ...partial,
  };
}

const FULL_WINDOW = { productId: PRODUCT, from: "2026-01-01", to: "2026-12-31" };

describe("filterReviews", () => {
  it("keeps only the product's reviews inside the inclusive range, oldest first", () => {
    const reviews: Review[] = [
      review({ id: "a", date: "2026-01-10", rating: 5, text: "Great sound." }),
      review({ id: "b", date: "2026-03-10", rating: 4, text: "Good battery." }),
      review({ id: "c", date: "2026-06-10", rating: 2, text: "The connection keeps dropping." }),
      { ...review({ id: "other", date: "2026-02-01", rating: 1, text: "sound" }), productId: "trailpeak-backpack" },
    ];

    const matched = filterReviews(reviews, PRODUCT, "2026-02-01", "2026-05-01");

    expect(matched.map((r) => r.id)).toEqual(["b"]);
  });
});

describe("analyze — filtering", () => {
  it("counts only reviews for the product within the date range", () => {
    const reviews: Review[] = [
      review({ id: "in-1", date: "2026-02-05", rating: 5, text: "Amazing sound." }),
      review({ id: "in-2", date: "2026-02-20", rating: 4, text: "Solid battery." }),
      review({ id: "out-early", date: "2026-01-01", rating: 5, text: "sound" }),
      review({ id: "out-late", date: "2026-05-01", rating: 5, text: "sound" }),
      { ...review({ id: "other-product", date: "2026-02-10", rating: 1, text: "sound" }), productId: "brewmaster-espresso" },
    ];

    const result = analyze({ productId: PRODUCT, from: "2026-02-01", to: "2026-02-28" }, reviews);

    expect(result.reviewCount).toBe(2);
    expect(result.averageRating).toBe(4.5);
  });
});

describe("analyze — invalid range", () => {
  it("throws AnalysisError when from is after to", () => {
    expect(() => analyze({ productId: PRODUCT, from: "2026-05-01", to: "2026-01-01" }, [])).toThrow(
      AnalysisError,
    );
  });

  it("throws AnalysisError for an unknown product", () => {
    expect(() => analyze({ productId: "nope", from: "2026-01-01", to: "2026-12-31" }, [])).toThrow(
      AnalysisError,
    );
  });
});

describe("analyze — empty result", () => {
  it("returns a zero-review result with no findings or recommendations", () => {
    const reviews: Review[] = [review({ id: "a", date: "2026-01-10", rating: 5, text: "Great sound." })];

    const result = analyze({ productId: PRODUCT, from: "2026-06-01", to: "2026-06-30" }, reviews);

    expect(result.reviewCount).toBe(0);
    expect(result.averageRating).toBe(0);
    expect(result.praise).toHaveLength(0);
    expect(result.faults).toHaveLength(0);
    expect(result.recommendations).toHaveLength(0);
    expect(result.summary).toMatch(/no reviews/i);
  });
});

describe("analyze — positive-theme aggregation", () => {
  it("aggregates matched positive reviews into a sorted praise finding", () => {
    const reviews: Review[] = [
      review({ id: "s1", date: "2026-02-01", rating: 5, text: "The sound quality is superb." }),
      review({ id: "s2", date: "2026-02-05", rating: 4, text: "Crisp sound and clear audio." }),
      review({ id: "b1", date: "2026-02-08", rating: 5, text: "Battery lasts all day." }),
    ];

    const result = analyze(FULL_WINDOW, reviews);
    const sound = result.praise.find((f) => f.label === "Sound quality");

    expect(sound?.mentions).toBe(2);
    expect(result.faults).toHaveLength(0);
    // Praise is sorted by mention count: Sound quality (2) before Battery life (1).
    expect(result.praise.map((f) => f.label)).toEqual(["Sound quality", "Battery life"]);
  });
});

describe("analyze — negative-theme aggregation", () => {
  it("aggregates matched negative reviews into a fault finding", () => {
    const reviews: Review[] = [
      review({ id: "c1", date: "2026-02-01", rating: 2, text: "The connection keeps dropping." }),
      review({ id: "c2", date: "2026-02-05", rating: 1, text: "Bluetooth drops on every call." }),
    ];

    const result = analyze(FULL_WINDOW, reviews);
    const connectivity = result.faults.find((f) => f.label === "Connectivity");

    expect(connectivity?.mentions).toBe(2);
    expect(result.praise).toHaveLength(0);
  });
});

describe("analyze — mention percentages", () => {
  it("computes percent as a share of all matched reviews", () => {
    const reviews: Review[] = [
      review({ id: "b1", date: "2026-02-01", rating: 5, text: "Battery lasts all day." }),
      review({ id: "n1", date: "2026-02-02", rating: 4, text: "Arrived on time and looked fine." }),
      review({ id: "n2", date: "2026-02-03", rating: 4, text: "Packaging was neat." }),
      review({ id: "n3", date: "2026-02-04", rating: 4, text: "Delivered quickly." }),
    ];

    const result = analyze(FULL_WINDOW, reviews);
    const battery = result.praise.find((f) => f.label === "Battery life");

    // 1 of 4 matched reviews mention battery -> 25%.
    expect(result.reviewCount).toBe(4);
    expect(battery?.mentions).toBe(1);
    expect(battery?.percent).toBe(25);
  });
});

describe("analyze — representative quotes", () => {
  it("takes each quote from an actual matched review", () => {
    const reviews: Review[] = [
      review({ id: "s1", date: "2026-02-01", rating: 5, text: "The sound quality is superb." }),
      review({ id: "c1", date: "2026-02-05", rating: 1, text: "Bluetooth connection drops constantly." }),
    ];

    const result = analyze(FULL_WINDOW, reviews);
    const findings = [...result.praise, ...result.faults];
    const corpus = reviews.map((r) => r.text);

    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      const source = corpus.find((text) => text.includes(f.quote));
      expect(source, `quote not found in any matched review: "${f.quote}"`).toBeTruthy();
    }
  });

  it("does not surface a quote from reviews outside the range", () => {
    const outsideText = "This sound is uniquely-unquotable-outside.";
    const reviews: Review[] = [
      review({ id: "in", date: "2026-02-01", rating: 5, text: "The sound quality is great." }),
      review({ id: "out", date: "2026-09-01", rating: 5, text: outsideText }),
    ];

    const result = analyze({ productId: PRODUCT, from: "2026-01-01", to: "2026-03-01" }, reviews);
    const quotes = [...result.praise, ...result.faults].map((f) => f.quote);

    expect(quotes.some((q) => q.includes("unquotable-outside"))).toBe(false);
  });
});

describe("analyze — recommendations", () => {
  it("omits recommendations when no negative theme appears", () => {
    const reviews: Review[] = [
      review({ id: "s1", date: "2026-02-01", rating: 5, text: "Wonderful sound quality." }),
      review({ id: "b1", date: "2026-02-05", rating: 5, text: "Battery is excellent." }),
    ];

    const result = analyze(FULL_WINDOW, reviews);

    expect(result.faults).toHaveLength(0);
    expect(result.recommendations).toHaveLength(0);
  });

  it("includes a recommendation only for a negative theme present in range", () => {
    const reviews: Review[] = [
      review({ id: "c1", date: "2026-02-01", rating: 2, text: "The connection keeps dropping on calls." }),
    ];

    const result = analyze(FULL_WINDOW, reviews);

    expect(result.faults.map((f) => f.label)).toContain("Connectivity");
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatch(/bluetooth/i);
  });
});

describe("analyze — one-review ranges", () => {
  it("summarizes a single review in the singular", () => {
    const reviews: Review[] = [
      review({ id: "only", date: "2026-02-01", rating: 4, text: "The sound quality is lovely." }),
    ];

    const result = analyze(FULL_WINDOW, reviews);

    expect(result.reviewCount).toBe(1);
    expect(result.summary).toMatch(/single review/i);
    expect(result.praise.find((f) => f.label === "Sound quality")?.mentions).toBe(1);
  });
});

describe("analyze — one-sided ranges", () => {
  it("only-positive: no faults and no recommendations", () => {
    const reviews: Review[] = [
      review({ id: "s1", date: "2026-02-01", rating: 5, text: "Fantastic sound." }),
      review({ id: "b1", date: "2026-02-05", rating: 5, text: "Great battery." }),
    ];

    const result = analyze(FULL_WINDOW, reviews);

    expect(result.praise.length).toBeGreaterThan(0);
    expect(result.faults).toHaveLength(0);
    expect(result.recommendations).toHaveLength(0);
    expect(result.summary).toMatch(/no recurring complaints/i);
  });

  it("only-negative: no praise", () => {
    const reviews: Review[] = [
      review({ id: "c1", date: "2026-02-01", rating: 1, text: "The connection keeps dropping." }),
      review({ id: "z1", date: "2026-02-05", rating: 2, text: "A zipper... n/a; touch controls too sensitive." }),
    ];

    const result = analyze(FULL_WINDOW, reviews);

    expect(result.faults.length).toBeGreaterThan(0);
    expect(result.praise).toHaveLength(0);
    expect(result.summary).toMatch(/little positive sentiment/i);
  });
});

describe("reviewStatsFor", () => {
  it("reports count and available date span for a product", () => {
    const reviews: Review[] = [
      review({ id: "a", date: "2026-03-01", rating: 5, text: "x" }),
      review({ id: "b", date: "2026-01-15", rating: 4, text: "y" }),
      { ...review({ id: "c", date: "2026-02-01", rating: 3, text: "z" }), productId: "trailpeak-backpack" },
    ];

    const stats = reviewStatsFor(PRODUCT, reviews);

    expect(stats.count).toBe(2);
    expect(stats.from).toBe("2026-01-15");
    expect(stats.to).toBe("2026-03-01");
  });
});
