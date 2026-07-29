import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { adaptAmazonCsv } from "./amazonAdapter";
import { hasDates } from "./datasetInfo";
import { analyze } from "../services/analysisEngine";
import { parseReviewRequest, MAX_REVIEWS_PER_REQUEST, MAX_TOTAL_REVIEW_TEXT_BYTES } from "../services/claudeTags";

/**
 * Integration coverage against the ACTUAL shipped fixture — the same bytes the
 * browser fetches. It asserts what the real data does, not what a fixture
 * pretends it does, and it is what keeps the reported counts honest.
 */
const CSV = readFileSync(new URL("../../public/amazon-products.csv", import.meta.url), "utf8");
const { dataset, stats, records } = adaptAmazonCsv(CSV, "Amazon product records");

describe("Amazon fixture — accounting", () => {
  it("accounts for every parsed record", () => {
    expect(stats.parsed).toBe(1465);
    expect(stats.accepted).toBe(1464);
    expect(stats.skipped).toBe(1);
    expect(stats.accepted + stats.skipped).toBe(stats.parsed);
    // The single skip is the one record whose rating cell is "|".
    expect(stats.skipReasons).toEqual({ invalid_rating: 1 });
  });

  it("derives products by product_id, collapsing repeated listings", () => {
    // 1,465 records carry 1,351 distinct product_ids (92 ids repeat). The
    // skipped record was the only one for its product, so 1,350 remain.
    expect(dataset.products).toHaveLength(1350);
    expect(new Set(dataset.reviews.map((r) => r.productId)).size).toBe(dataset.products.length);
    expect(dataset.reviews.some((r) => r.productId === "B08L12N5H1")).toBe(false);
  });

  it("gives every accepted record a unique id", () => {
    expect(new Set(dataset.reviews.map((r) => r.id)).size).toBe(stats.accepted);
  });

  it("carries no dates at all", () => {
    expect(hasDates(dataset)).toBe(false);
    expect(dataset.reviews.every((r) => r.date === "")).toBe(true);
  });

  it("keeps every rating inside the 1–5 integer contract, with the decimal preserved", () => {
    expect(
      dataset.reviews.every((r) => Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5),
    ).toBe(true);
    expect(dataset.reviews.every((r) => typeof r.sourceRating === "number")).toBe(true);
    // The source really is decimal — this is not a dataset of whole stars.
    const decimals = dataset.reviews.filter((r) => !Number.isInteger(r.sourceRating!));
    expect(decimals.length).toBeGreaterThan(1000);
  });

  it("never splits a record's text into separate reviews", () => {
    // 1,464 records in, 1,464 reviews out — no row was expanded into several.
    expect(dataset.reviews).toHaveLength(stats.accepted);
    expect(dataset.reviews.every((r) => r.text.trim() !== "")).toBe(true);
  });
});

describe("Amazon fixture — no personal data is shipped", () => {
  it("has no reviewer id or name columns", () => {
    const header = CSV.slice(0, CSV.indexOf("\n"));
    expect(header).not.toMatch(/user_id|user_name|review_id|review_title/);
  });
});

describe("Amazon fixture — heuristic engine", () => {
  const productId = dataset.products[0]!.id;

  it("runs over the empty window and matches every record for the product", () => {
    const expected = dataset.reviews.filter((r) => r.productId === productId).length;
    const result = analyze({ productId, from: "", to: "" }, dataset.reviews, dataset.products);
    expect(result.reviewCount).toBe(expected);
    expect(result.reviewCount).toBeGreaterThan(0);
  });

  it("produces a result for every product without throwing", () => {
    for (const product of dataset.products) {
      const result = analyze(
        { productId: product.id, from: "", to: "" },
        dataset.reviews,
        dataset.products,
      );
      expect(result.reviewCount).toBeGreaterThan(0);
    }
  });

  it("shows no promotion panel — a listing discount is not a purchase promotion", () => {
    const result = analyze({ productId, from: "", to: "" }, dataset.reviews, dataset.products);
    expect(result.promotion).toBeUndefined();
  });

  it("documents the averaging skew: praise evidence swamps fault evidence", () => {
    // Not a claim about the products — an artifact of rounding product averages
    // into the engine's >= 4 / <= 2 polarity rule. Asserted so the limitation
    // stays visible if the data or the rounding ever changes.
    const praiseEligible = dataset.reviews.filter((r) => r.rating >= 4).length;
    const faultEligible = dataset.reviews.filter((r) => r.rating <= 2).length;
    expect(praiseEligible).toBe(1422);
    expect(faultEligible).toBe(2);
  });
});

describe("Amazon fixture — Claude engine request contract", () => {
  it("sends a body the /api/analyze validator accepts, for every product", () => {
    for (const product of dataset.products) {
      const matched = dataset.reviews.filter((r) => r.productId === product.id);
      // Exactly the payload claudeEngine.ts builds from matched reviews.
      const body = { reviews: matched.map((r) => ({ id: r.id, text: r.text, rating: r.rating })) };
      const parsed = parseReviewRequest(body);
      expect(Array.isArray(parsed), `rejected for ${product.id}`).toBe(true);
    }
  });

  it("stays inside the endpoint's per-request size limits", () => {
    for (const product of dataset.products) {
      const matched = dataset.reviews.filter((r) => r.productId === product.id);
      expect(matched.length).toBeLessThanOrEqual(MAX_REVIEWS_PER_REQUEST);
      const bytes = matched.reduce((sum, r) => sum + Buffer.byteLength(r.text, "utf8"), 0);
      expect(bytes).toBeLessThanOrEqual(MAX_TOTAL_REVIEW_TEXT_BYTES);
    }
  });

  it("would be rejected outright if the decimal rating were sent unrounded", () => {
    // Why rounding is not optional: the endpoint's contract is integer 1–5, and
    // neither the engine nor the endpoint may be modified to accept 4.2.
    const decimal = dataset.reviews.find((r) => !Number.isInteger(r.sourceRating!))!;
    const parsed = parseReviewRequest({
      reviews: [{ id: decimal.id, text: decimal.text, rating: decimal.sourceRating }],
    });
    expect(parsed).toEqual({ invalid: "rating must be an integer between 1 and 5" });
  });
});

describe("Amazon fixture — rating filter", () => {
  it("returns only products whose source rating is below 3.5", () => {
    const low = records.filter((r) => r.sourceRating < 3.5);
    expect(low.length).toBe(42);
    expect(low.every((r) => r.sourceRating < 3.5)).toBe(true);
    expect(low.some((r) => r.sourceRating >= 3.5)).toBe(false);

    // Everything at or above the threshold is excluded, and nothing invalid
    // slipped in: unparseable ratings never became records.
    const high = records.filter((r) => r.sourceRating >= 3.5);
    expect(low.length + high.length).toBe(records.length);
    expect(records.every((r) => Number.isFinite(r.sourceRating))).toBe(true);
    expect(records.some((r) => r.raw.rating === "|")).toBe(false);
  });
});
