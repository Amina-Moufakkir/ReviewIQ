import { describe, it, expect } from "vitest";
import type { Product, Review } from "../types";
import { analyze, filterReviews, reviewStatsFor, AnalysisError, MIN_EVIDENCE } from "./analysisEngine";

const PRODUCT_ID = "widget-01";
const PRODUCTS: Product[] = [
  { id: PRODUCT_ID, name: "Test Widget", category: "Electronics" },
  { id: "other-01", name: "Other Widget", category: "Electronics" },
];

// Helper to build reviews. Text is written so keywords land on known library
// themes: "sound"/"battery" (positive-leaning aspects), "connection"/"bluetooth"
// (Connectivity).
function review(
  partial: Partial<Review> & Pick<Review, "id" | "date" | "rating" | "text">,
): Review {
  return { productId: PRODUCT_ID, ...partial };
}

const FULL = { productId: PRODUCT_ID, from: "2026-01-01", to: "2026-12-31" };

describe("filterReviews", () => {
  it("keeps only the product's reviews inside the inclusive range, oldest first", () => {
    const reviews: Review[] = [
      review({ id: "a", date: "2026-01-10", rating: 5, text: "Great sound." }),
      review({ id: "b", date: "2026-03-10", rating: 4, text: "Good battery." }),
      review({ id: "c", date: "2026-06-10", rating: 2, text: "The connection keeps dropping." }),
      { ...review({ id: "x", date: "2026-02-01", rating: 1, text: "sound" }), productId: "other-01" },
    ];
    expect(filterReviews(reviews, PRODUCT_ID, "2026-02-01", "2026-05-01").map((r) => r.id)).toEqual(["b"]);
  });
});

describe("analyze — filtering", () => {
  it("counts only reviews for the product within the date range", () => {
    const reviews: Review[] = [
      review({ id: "in1", date: "2026-02-05", rating: 5, text: "Amazing sound." }),
      review({ id: "in2", date: "2026-02-20", rating: 4, text: "Solid sound too." }),
      review({ id: "early", date: "2026-01-01", rating: 5, text: "sound" }),
      review({ id: "late", date: "2026-05-01", rating: 5, text: "sound" }),
      { ...review({ id: "other", date: "2026-02-10", rating: 1, text: "sound" }), productId: "other-01" },
    ];
    const result = analyze({ productId: PRODUCT_ID, from: "2026-02-01", to: "2026-02-28" }, reviews, PRODUCTS);
    expect(result.reviewCount).toBe(2);
    expect(result.averageRating).toBe(4.5);
  });
});

describe("analyze — invalid input", () => {
  it("throws AnalysisError when from is after to", () => {
    expect(() => analyze({ productId: PRODUCT_ID, from: "2026-05-01", to: "2026-01-01" }, [], PRODUCTS)).toThrow(AnalysisError);
  });
  it("throws AnalysisError for an unknown product", () => {
    expect(() => analyze({ productId: "nope", from: "2026-01-01", to: "2026-12-31" }, [], PRODUCTS)).toThrow(AnalysisError);
  });
});

describe("analyze — empty result", () => {
  it("returns a zero-review result with no findings or recommendations", () => {
    const reviews: Review[] = [review({ id: "a", date: "2026-01-10", rating: 5, text: "Great sound." })];
    const result = analyze({ productId: PRODUCT_ID, from: "2026-06-01", to: "2026-06-30" }, reviews, PRODUCTS);
    expect(result.reviewCount).toBe(0);
    expect(result.averageRating).toBe(0);
    expect(result.praise).toHaveLength(0);
    expect(result.faults).toHaveLength(0);
    expect(result.recommendations).toHaveLength(0);
    expect(result.summary).toMatch(/no reviews/i);
  });
});

describe("analyze — minimum evidence threshold", () => {
  it("does not surface a theme with only one supporting review", () => {
    const reviews: Review[] = [
      review({ id: "s1", date: "2026-02-01", rating: 5, text: "The sound quality is superb." }),
      review({ id: "n1", date: "2026-02-02", rating: 5, text: "Arrived on time, packaging was neat." }),
    ];
    const result = analyze(FULL, reviews, PRODUCTS);
    expect(MIN_EVIDENCE).toBeGreaterThanOrEqual(2);
    expect(result.praise.find((f) => f.label === "Sound quality")).toBeUndefined();
  });

  it("surfaces a theme once it reaches the threshold", () => {
    const reviews: Review[] = [
      review({ id: "s1", date: "2026-02-01", rating: 5, text: "The sound quality is superb." }),
      review({ id: "s2", date: "2026-02-05", rating: 4, text: "Crisp sound and clear audio." }),
    ];
    const result = analyze(FULL, reviews, PRODUCTS);
    expect(result.praise.find((f) => f.label === "Sound quality")?.mentions).toBe(2);
  });
});

describe("analyze — rating drives sentiment", () => {
  it("aggregates high-rated mentions as praise and low-rated as faults", () => {
    const reviews: Review[] = [
      review({ id: "p1", date: "2026-02-01", rating: 5, text: "The sound quality is superb." }),
      review({ id: "p2", date: "2026-02-02", rating: 4, text: "Great sound overall." }),
      review({ id: "f1", date: "2026-02-03", rating: 1, text: "The connection keeps dropping." }),
      review({ id: "f2", date: "2026-02-04", rating: 2, text: "Bluetooth drops on every call." }),
    ];
    const result = analyze(FULL, reviews, PRODUCTS);
    expect(result.praise.find((f) => f.label === "Sound quality")?.mentions).toBe(2);
    expect(result.faults.find((f) => f.label === "Connectivity")?.mentions).toBe(2);
  });

  it("does NOT count a theme praised inside a low-rated review as praise", () => {
    // Two 1-star reviews that both mention 'sound' positively in wording, but
    // the low rating means this is not positive evidence.
    const reviews: Review[] = [
      review({ id: "a", date: "2026-02-01", rating: 1, text: "The sound is nice but it broke in a week." }),
      review({ id: "b", date: "2026-02-02", rating: 1, text: "Nice sound, yet it stopped working." }),
    ];
    const result = analyze(FULL, reviews, PRODUCTS);
    expect(result.praise.find((f) => f.label === "Sound quality")).toBeUndefined();
  });

  it("lets a split-opinion theme appear in both praise and faults", () => {
    const reviews: Review[] = [
      review({ id: "p1", date: "2026-02-01", rating: 5, text: "The sound is fantastic." }),
      review({ id: "p2", date: "2026-02-02", rating: 5, text: "Superb sound quality." }),
      review({ id: "f1", date: "2026-02-03", rating: 1, text: "Tinny, hollow sound." }),
      review({ id: "f2", date: "2026-02-04", rating: 2, text: "The sound is muddy and flat." }),
    ];
    const result = analyze(FULL, reviews, PRODUCTS);
    expect(result.praise.some((f) => f.label === "Sound quality")).toBe(true);
    expect(result.faults.some((f) => f.label === "Sound quality")).toBe(true);
  });

  it("treats rating 3 as neutral — not enough polar evidence on its own", () => {
    const reviews: Review[] = [
      review({ id: "n1", date: "2026-02-01", rating: 3, text: "The sound is okay, nothing special." }),
      review({ id: "n2", date: "2026-02-02", rating: 3, text: "Average sound, average battery." }),
    ];
    const result = analyze(FULL, reviews, PRODUCTS);
    expect(result.praise).toHaveLength(0);
    expect(result.faults).toHaveLength(0);
  });
});

describe("analyze — percentages", () => {
  it("computes percent as a share of all matched reviews", () => {
    const reviews: Review[] = [
      review({ id: "p1", date: "2026-02-01", rating: 5, text: "Great sound quality." }),
      review({ id: "p2", date: "2026-02-02", rating: 5, text: "Excellent sound." }),
      review({ id: "n1", date: "2026-02-03", rating: 5, text: "Arrived quickly, neat box." }),
      review({ id: "n2", date: "2026-02-04", rating: 5, text: "Delivered on time." }),
    ];
    const result = analyze(FULL, reviews, PRODUCTS);
    const sound = result.praise.find((f) => f.label === "Sound quality");
    expect(result.reviewCount).toBe(4);
    expect(sound?.mentions).toBe(2);
    expect(sound?.percent).toBe(50);
  });
});

describe("analyze — representative quotes", () => {
  it("takes each quote from an actual matched review and matching polarity", () => {
    const reviews: Review[] = [
      review({ id: "p1", date: "2026-02-01", rating: 5, text: "The sound quality is superb." }),
      review({ id: "p2", date: "2026-02-02", rating: 4, text: "Crisp, clear sound." }),
      review({ id: "f1", date: "2026-02-03", rating: 1, text: "Bluetooth connection drops constantly." }),
      review({ id: "f2", date: "2026-02-04", rating: 2, text: "The connection is unreliable." }),
    ];
    const result = analyze(FULL, reviews, PRODUCTS);
    const corpus = reviews.map((r) => r.text);
    for (const f of [...result.praise, ...result.faults]) {
      expect(corpus.some((t) => t.includes(f.quote)), `quote not from a matched review: "${f.quote}"`).toBe(true);
    }
  });

  it("does not surface a quote from reviews outside the range", () => {
    const reviews: Review[] = [
      review({ id: "in1", date: "2026-02-01", rating: 5, text: "The sound quality is great." }),
      review({ id: "in2", date: "2026-02-02", rating: 5, text: "Lovely sound." }),
      review({ id: "out", date: "2026-09-01", rating: 5, text: "This sound is uniquely-unquotable-outside." }),
    ];
    const result = analyze({ productId: PRODUCT_ID, from: "2026-01-01", to: "2026-03-01" }, reviews, PRODUCTS);
    const quotes = [...result.praise, ...result.faults].map((f) => f.quote);
    expect(quotes.some((q) => q.includes("unquotable-outside"))).toBe(false);
  });

  it("attributes anonymous reviews by verification and country", () => {
    const reviews: Review[] = [
      review({ id: "f1", date: "2026-02-01", rating: 1, text: "The connection keeps dropping.", verifiedPurchase: true, country: "US" }),
      review({ id: "f2", date: "2026-02-02", rating: 2, text: "Bluetooth won't stay connected." }),
    ];
    const result = analyze(FULL, reviews, PRODUCTS);
    const conn = result.faults.find((f) => f.label === "Connectivity");
    expect(conn?.quoteAuthor).toBe("Verified buyer · US");
  });
});

describe("analyze — recommendations", () => {
  it("omits recommendations when no fault theme has enough evidence", () => {
    const reviews: Review[] = [
      review({ id: "p1", date: "2026-02-01", rating: 5, text: "Wonderful sound quality." }),
      review({ id: "p2", date: "2026-02-05", rating: 5, text: "Sound is excellent." }),
    ];
    const result = analyze(FULL, reviews, PRODUCTS);
    expect(result.faults).toHaveLength(0);
    expect(result.recommendations).toHaveLength(0);
  });

  it("includes a recommendation for each fault theme present, ordered like faults", () => {
    const reviews: Review[] = [
      review({ id: "f1", date: "2026-02-01", rating: 1, text: "The connection keeps dropping on calls." }),
      review({ id: "f2", date: "2026-02-02", rating: 2, text: "Bluetooth disconnecting all the time." }),
    ];
    const result = analyze(FULL, reviews, PRODUCTS);
    expect(result.faults.map((f) => f.label)).toContain("Connectivity");
    expect(result.recommendations).toHaveLength(result.faults.length);
    expect(result.recommendations.join(" ")).toMatch(/connection/i);
  });
});

describe("analyze — one-review range", () => {
  it("summarizes a single review in the singular", () => {
    const reviews: Review[] = [review({ id: "only", date: "2026-02-01", rating: 4, text: "The sound quality is lovely." })];
    const result = analyze(FULL, reviews, PRODUCTS);
    expect(result.reviewCount).toBe(1);
    expect(result.summary).toMatch(/single review/i);
    // One supporting review is below MIN_EVIDENCE, so no finding surfaces.
    expect(result.praise).toHaveLength(0);
  });
});

describe("analyze — one-sided ranges", () => {
  it("only-positive: no faults and no recommendations", () => {
    const reviews: Review[] = [
      review({ id: "p1", date: "2026-02-01", rating: 5, text: "Fantastic sound." }),
      review({ id: "p2", date: "2026-02-05", rating: 5, text: "Great sound quality." }),
    ];
    const result = analyze(FULL, reviews, PRODUCTS);
    expect(result.praise.length).toBeGreaterThan(0);
    expect(result.faults).toHaveLength(0);
    expect(result.recommendations).toHaveLength(0);
    expect(result.summary).toMatch(/no recurring complaints/i);
  });

  it("only-negative: no praise", () => {
    const reviews: Review[] = [
      review({ id: "f1", date: "2026-02-01", rating: 1, text: "The connection keeps dropping." }),
      review({ id: "f2", date: "2026-02-05", rating: 2, text: "Bluetooth pairing fails constantly." }),
    ];
    const result = analyze(FULL, reviews, PRODUCTS);
    expect(result.faults.length).toBeGreaterThan(0);
    expect(result.praise).toHaveLength(0);
    expect(result.summary).toMatch(/little positive sentiment/i);
  });
});

describe("analyze — theme matching precision (whole-word)", () => {
  const labels = (fs: { label: string }[]) => fs.map((f) => f.label);

  it("does not produce a Cleaning finding from 'cleaner teeth'", () => {
    const reviews: Review[] = [
      review({ id: "a", date: "2026-02-01", rating: 5, text: "It leaves me with cleaner teeth every morning." }),
      review({ id: "b", date: "2026-02-02", rating: 5, text: "Noticeably cleaner teeth after two weeks." }),
    ];
    const result = analyze(FULL, reviews, PRODUCTS);
    expect(labels(result.praise)).not.toContain("Cleaning");
    expect(labels(result.faults)).not.toContain("Cleaning");
  });

  it("still produces a Cleaning finding from 'easy to clean'", () => {
    const reviews: Review[] = [
      review({ id: "a", date: "2026-02-01", rating: 5, text: "The tray is easy to clean." }),
      review({ id: "b", date: "2026-02-02", rating: 5, text: "Very easy to clean after each use." }),
    ];
    const result = analyze(FULL, reviews, PRODUCTS);
    expect(labels(result.praise)).toContain("Cleaning");
  });

  it("does not produce a Build quality finding from 'hard to build'", () => {
    const reviews: Review[] = [
      review({ id: "a", date: "2026-02-01", rating: 2, text: "It was hard to build from the instructions." }),
      review({ id: "b", date: "2026-02-02", rating: 2, text: "Really hard to build; parts did not line up." }),
    ];
    const result = analyze(FULL, reviews, PRODUCTS);
    expect(labels(result.praise)).not.toContain("Build quality");
    expect(labels(result.faults)).not.toContain("Build quality");
    // The phrase legitimately belongs to Assembly.
    expect(labels(result.faults)).toContain("Assembly");
  });

  it("still produces a Build quality finding from 'build quality feels sturdy'", () => {
    const reviews: Review[] = [
      review({ id: "a", date: "2026-02-01", rating: 5, text: "The build quality feels sturdy and solid." }),
      review({ id: "b", date: "2026-02-02", rating: 5, text: "Excellent build quality throughout." }),
    ];
    const result = analyze(FULL, reviews, PRODUCTS);
    expect(labels(result.praise)).toContain("Build quality");
  });

  it("matches themes case-insensitively", () => {
    const reviews: Review[] = [
      review({ id: "a", date: "2026-02-01", rating: 5, text: "GREAT SOUND, very clear." }),
      review({ id: "b", date: "2026-02-02", rating: 5, text: "The SOUND is excellent." }),
    ];
    const result = analyze(FULL, reviews, PRODUCTS);
    expect(labels(result.praise)).toContain("Sound quality");
  });
});

describe("reviewStatsFor", () => {
  it("reports count and available date span for a product", () => {
    const reviews: Review[] = [
      review({ id: "a", date: "2026-03-01", rating: 5, text: "x" }),
      review({ id: "b", date: "2026-01-15", rating: 4, text: "y" }),
      { ...review({ id: "c", date: "2026-02-01", rating: 3, text: "z" }), productId: "other-01" },
    ];
    const stats = reviewStatsFor(PRODUCT_ID, reviews);
    expect(stats.count).toBe(2);
    expect(stats.from).toBe("2026-01-15");
    expect(stats.to).toBe("2026-03-01");
  });
});
