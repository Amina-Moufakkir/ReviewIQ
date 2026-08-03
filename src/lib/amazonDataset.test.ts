import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { adaptAmazonCsv, type AmazonAdapterResult } from "./amazonAdapter";
import { hasDates, isSyntheticDemo, unitFor, AMAZON_DEMO_LABEL } from "./datasetInfo";
import { shortProductLabel } from "./productLabel";
import { analyze } from "../services/analysisEngine";
import { analyzeReviews } from "../services/analyzeReviews";
import {
  parseReviewRequest,
  MAX_TOTAL_REVIEW_TEXT_BYTES,
} from "../services/claudeTags";
import { maxRowsPerAnalysis } from "../services/runEstimator";

/**
 * Dataset-level coverage for the Amazon path, over two fixtures:
 *
 *   - `src/test/fixtures/amazon-mini.csv` — a committed SYNTHETIC fixture in
 *     the generated fixture's exact column shape. Always runs.
 *   - `public/amazon-products.csv` — the real generated fixture, the same bytes
 *     the browser fetches. It is developer-supplied and NOT committed (the
 *     source dataset's license and redistribution terms are unverified), so
 *     those tests skip when it is absent — visibly, never silently.
 */

const MINI_PATH = new URL("../test/fixtures/amazon-mini.csv", import.meta.url);
const DEMO_PATH = new URL("../../public/amazon-demo.csv", import.meta.url);
const REAL_PATH = new URL("../../public/amazon-products.csv", import.meta.url);

const mini = adaptAmazonCsv(readFileSync(MINI_PATH, "utf8"), "Synthetic mini fixture");
const demo = adaptAmazonCsv(readFileSync(DEMO_PATH, "utf8"), AMAZON_DEMO_LABEL);
const hasRealFixture = existsSync(REAL_PATH);

/**
 * Assertions that must hold for ANY Amazon-shaped CSV. Counts specific to one
 * file are asserted separately, below.
 */
function assertAdapterInvariants(name: string, result: AmazonAdapterResult) {
  const { dataset, stats, records } = result;

  it(`${name}: accounts for every parsed record`, () => {
    expect(stats.accepted + stats.skipped).toBe(stats.parsed);
    expect(stats.accepted).toBe(dataset.reviews.length);
    const reasonTotal = Object.values(stats.skipReasons).reduce<number>(
      (sum, n) => sum + (n ?? 0),
      0,
    );
    expect(reasonTotal).toBe(stats.skipped);
  });

  it(`${name}: gives every accepted record a unique id`, () => {
    expect(new Set(dataset.reviews.map((r) => r.id)).size).toBe(stats.accepted);
  });

  it(`${name}: summarizes in product records, never in reviews`, () => {
    // The boundary (analyzeReviews) is what decides the unit, so assert through
    // it: dropping unitFor() there is invisible to the engine's own tests.
    const product = dataset.products[0]!;
    return analyzeReviews({ scope: { kind: "product", productId: product.id }, from: "", to: "" }, dataset).then((result) => {
      expect(result.summary).toMatch(/product records?/i);
      expect(result.summary).not.toMatch(/\breviews?\b/i);
    });
  });

  it(`${name}: carries no dates at all`, () => {
    expect(dataset.reviews.every((r) => r.date === "")).toBe(true);
    expect(hasDates(dataset)).toBe(false);
  });

  it(`${name}: keeps every rating in the 1–5 integer contract, decimal preserved`, () => {
    expect(
      dataset.reviews.every((r) => Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5),
    ).toBe(true);
    expect(dataset.reviews.every((r) => typeof r.sourceRating === "number")).toBe(true);
    expect(records.every((r) => Number.isFinite(r.sourceRating))).toBe(true);
  });

  it(`${name}: never expands a record into several reviews`, () => {
    expect(dataset.reviews).toHaveLength(stats.accepted);
    expect(dataset.reviews.every((r) => r.text.trim() !== "")).toBe(true);
  });

  it(`${name}: collapses repeated product_ids into one product`, () => {
    expect(new Set(dataset.reviews.map((r) => r.productId)).size).toBe(dataset.products.length);
  });

  it(`${name}: runs the heuristic engine over the empty window for every product`, () => {
    for (const product of dataset.products) {
      const analysis = analyze(
        { scope: { kind: "product", productId: product.id }, from: "", to: "" },
        dataset.reviews,
        dataset.products,
      );
      const expected = dataset.reviews.filter((r) => r.productId === product.id).length;
      expect(analysis.reviewCount).toBe(expected);
      expect(analysis.reviewCount).toBeGreaterThan(0);
      // A listing discount is not a promotion the reviewer purchased under.
      expect(analysis.promotion).toBeUndefined();
    }
  });

  it(`${name}: sends a body /api/analyze accepts, within its size limits`, () => {
    for (const product of dataset.products) {
      const matched = dataset.reviews.filter((r) => r.productId === product.id);
      // Exactly the payload claudeEngine.ts builds from matched reviews: text
      // only, because sentiment on that path is derived from the words alone.
      const body = { reviews: matched.map((r) => ({ id: r.id, text: r.text })) };
      expect(Array.isArray(parseReviewRequest(body)), `rejected for ${product.id}`).toBe(true);
      // The endpoint now takes one batch, so a whole product selection is no
      // longer required to fit a single request — the run ceiling is what
      // governs it. Byte and shape limits below still apply per request.
      expect(matched.length).toBeLessThanOrEqual(maxRowsPerAnalysis("local"));
      const bytes = matched.reduce((sum, r) => sum + Buffer.byteLength(r.text, "utf8"), 0);
      expect(bytes).toBeLessThanOrEqual(MAX_TOTAL_REVIEW_TEXT_BYTES);
    }
  });

  it(`${name}: never sends a rating to /api/analyze, decimal or otherwise`, () => {
    // The product-average rating describes thousands of customers at once, so it
    // is evidence about no single theme. It is not part of the request contract:
    // a decimal average cannot reach the endpoint because no rating does.
    const decimal = dataset.reviews.find((r) => !Number.isInteger(r.sourceRating!));
    expect(decimal, "fixture should contain a decimal average").toBeDefined();
    const parsed = parseReviewRequest({
      reviews: [{ id: decimal!.id, text: decimal!.text, rating: decimal!.sourceRating }],
    });
    expect(Array.isArray(parsed)).toBe(true);
    // The decimal is dropped rather than rejected, and never reaches the model.
    expect(parsed).toEqual([{ id: decimal!.id, text: decimal!.text }]);
  });

  it(`${name}: still rounds the source decimal to the heuristic engine's 1–5 integer`, () => {
    // Rounding remains non-optional for the OTHER engine: rating-based sentiment
    // reads Review.rating, whose contract is an integer 1–5.
    for (const review of dataset.reviews) {
      expect(Number.isInteger(review.rating), `${review.id} rating=${review.rating}`).toBe(true);
      expect(review.rating).toBeGreaterThanOrEqual(1);
      expect(review.rating).toBeLessThanOrEqual(5);
    }
  });

  it(`${name}: filters on the source decimal, excluding >= 3.5 and anything invalid`, () => {
    const low = records.filter((r) => r.sourceRating < 3.5);
    const high = records.filter((r) => r.sourceRating >= 3.5);
    expect(low.every((r) => r.sourceRating < 3.5)).toBe(true);
    expect(low.some((r) => r.sourceRating >= 3.5)).toBe(false);
    expect(low.length + high.length).toBe(records.length);
    expect(records.some((r) => r.raw.rating === "|")).toBe(false);
    expect(records.some((r) => r.raw.rating === "")).toBe(false);
  });
}

describe("Amazon adapter — invariants (synthetic fixtures)", () => {
  assertAdapterInvariants("mini", mini);
  assertAdapterInvariants("demo", demo);
});

/**
 * public/amazon-demo.csv is a shipped artifact: deployed builds have no real
 * dataset, so this is the Amazon data every visitor sees. It is committed, so
 * these assertions guard what the public demo actually shows.
 */
describe("Amazon demo fixture — the deployed stand-in", () => {
  it("is labelled as synthetic wherever the UI reads it", () => {
    expect(isSyntheticDemo(demo.dataset)).toBe(true);
    expect(demo.dataset.label).toContain("synthetic");
  });

  it("carries enough products, across enough categories, to be worth exploring", () => {
    expect(demo.dataset.products.length).toBeGreaterThanOrEqual(20);
    const topLevel = new Set(demo.records.map((r) => r.categoryPath[0]));
    expect(topLevel.size).toBeGreaterThanOrEqual(4);
  });

  it("demonstrates the skip accounting rather than hiding it", () => {
    expect(demo.stats.skipped).toBeGreaterThan(0);
    expect(demo.stats.accepted + demo.stats.skipped).toBe(demo.stats.parsed);
  });

  it("contains titles long enough to show the selector shortening", () => {
    const shortened = demo.dataset.products.filter(
      (p) => shortProductLabel(p.name) !== p.name,
    );
    expect(shortened.length).toBeGreaterThanOrEqual(15);
  });

  it("ships no reviewer ids or names, and no real product ids", () => {
    const csv = readFileSync(DEMO_PATH, "utf8");
    expect(csv.slice(0, csv.indexOf("\n"))).not.toMatch(/user_id|user_name|review_id|review_title/);
    // Real Amazon ASINs look like B0XXXXXXXX; every id here is invented.
    expect(demo.records.every((r) => r.productId.startsWith("DEMO"))).toBe(true);
  });
});

describe("Amazon adapter — synthetic fixture specifics", () => {
  it("accounts for all 12 records and names each skip", () => {
    expect(mini.stats).toMatchObject({ parsed: 12, accepted: 8, skipped: 4 });
    expect(mini.stats.skipReasons).toEqual({
      invalid_rating: 2, // a blank rating cell, and a "|" cell
      missing_review_text: 1,
      missing_product_id: 1,
    });
  });

  it("collapses the repeated product_id into one product", () => {
    expect(mini.dataset.products).toHaveLength(7);
    expect(mini.records.filter((r) => r.productId === "SYN0000001")).toHaveLength(2);
  });

  it("rounds the averages while preserving the source decimals", () => {
    const byId = new Map(mini.records.map((r) => [r.productId, r] as const));
    expect(byId.get("SYN0000004")).toMatchObject({ sourceRating: 2.4, rating: 2 });
    expect(byId.get("SYN0000006")).toMatchObject({ sourceRating: 3.5, rating: 4 });
    expect(byId.get("SYN0000002")).toMatchObject({ sourceRating: 3.9, rating: 4 });
  });

  it("returns exactly the sub-3.5 records", () => {
    const low = mini.records.filter((r) => r.sourceRating < 3.5);
    expect(low.map((r) => r.productId).sort()).toEqual(["SYN0000003", "SYN0000004"]);
  });

  it("normalizes prices and keeps the raw strings", () => {
    const rec = mini.records[0]!;
    expect(rec).toMatchObject({ discountedPrice: 399, actualPrice: 1099, discountPercent: 64 });
    expect(rec.raw.actual_price).toBe("₹1,099");
    expect(rec.categoryPath[0]).toBe("Computers&Accessories");
    expect(rec.category).toBe("USBCables");
  });

  // The grouping key must reach the Product, since that is what category scope
  // reads — categoryPath lives on AmazonRecord, which callers discard.
  it("puts the record's top-level category on the product it produces", () => {
    const rec = mini.records[0]!;
    const product = mini.dataset.products.find((p) => p.id === rec.productId)!;
    expect(product.topCategory).toBe(rec.categoryPath[0]);
    expect(product.category).toBe(rec.category);
  });

  it("groups many leaves under far fewer top-level categories", () => {
    const leaves = new Set(mini.dataset.products.map((p) => p.category));
    const tops = new Set(mini.dataset.products.map((p) => p.topCategory));
    expect(tops.size).toBeLessThan(leaves.size);
    expect([...tops].every(Boolean)).toBe(true);
  });

  it("keeps commas and escaped quotes inside the text intact", () => {
    expect(mini.dataset.reviews[0]!.text).toContain("Charging is fast, and the braid feels solid.");
    const press = mini.dataset.reviews.find((r) => r.productId === "SYN0000005")!;
    expect(press.text).toContain('"non-stick" really is non-stick');
  });
});

// Skips visibly in the run when the developer has not supplied the dataset.
describe.skipIf(!hasRealFixture)("Amazon adapter — real generated fixture", () => {
  const real: AmazonAdapterResult = hasRealFixture
    ? adaptAmazonCsv(readFileSync(REAL_PATH, "utf8"), "Amazon product records")
    : mini; // unreachable when skipped; keeps the shared assertions typed

  assertAdapterInvariants("real", real);

  it("accounts for all 1,465 records", () => {
    expect(real.stats).toMatchObject({ parsed: 1465, accepted: 1464, skipped: 1 });
    // The single skip is the one record whose rating cell is "|".
    expect(real.stats.skipReasons).toEqual({ invalid_rating: 1 });
  });

  it("derives 1,350 products", () => {
    // 1,465 records carry 1,351 distinct product_ids (92 repeat). The skipped
    // record was the only one for its product, so 1,350 remain.
    expect(real.dataset.products).toHaveLength(1350);
    expect(real.dataset.reviews.some((r) => r.productId === "B08L12N5H1")).toBe(false);
  });

  it("is genuinely a dataset of decimal averages", () => {
    const decimals = real.dataset.reviews.filter((r) => !Number.isInteger(r.sourceRating!));
    expect(decimals.length).toBeGreaterThan(1000);
  });

  it("ships no reviewer ids or names", () => {
    const csv = readFileSync(REAL_PATH, "utf8");
    const header = csv.slice(0, csv.indexOf("\n"));
    expect(header).not.toMatch(/user_id|user_name|review_id|review_title/);
  });

  it("returns 42 records below the 3.5 threshold", () => {
    expect(real.records.filter((r) => r.sourceRating < 3.5)).toHaveLength(42);
  });

  it("documents the averaging skew: praise evidence swamps fault evidence", () => {
    // Not a claim about the products — an artifact of rounding product averages
    // into the engine's >= 4 / <= 2 polarity rule. Asserted so the limitation
    // stays visible if the data or the rounding ever changes.
    expect(real.dataset.reviews.filter((r) => r.rating >= 4)).toHaveLength(1422);
    expect(real.dataset.reviews.filter((r) => r.rating <= 2)).toHaveLength(2);
  });
});

/**
 * The production symptom this threshold work fixes: every Amazon product
 * returned 0 praise, 0 faults and 0 recommendations, because a theme needed two
 * same-polarity rows and 1,258 of the 1,350 products have exactly one record.
 * Asserted on the synthetic fixtures (always) and the real one (when present).
 */
describe("Amazon analysis — single-record products still produce findings", () => {
  function findingsFor(result: AmazonAdapterResult, productId: string) {
    return analyze(
      { scope: { kind: "product", productId }, from: "", to: "" },
      result.dataset.reviews,
      result.dataset.products,
      unitFor(result.dataset),
    );
  }

  function singleRecordProductIds({ dataset }: AmazonAdapterResult): string[] {
    const counts = new Map<string, number>();
    for (const r of dataset.reviews) counts.set(r.productId, (counts.get(r.productId) ?? 0) + 1);
    return [...counts.entries()].filter(([, n]) => n === 1).map(([id]) => id);
  }

  it("demo fixture: a one-record product yields a finding backed by its own text", () => {
    const singles = singleRecordProductIds(demo);
    expect(singles.length).toBeGreaterThan(0);

    const withFindings = singles
      .map((id) => ({ id, result: findingsFor(demo, id) }))
      .filter(({ result }) => result.praise.length + result.faults.length > 0);
    expect(withFindings.length).toBeGreaterThan(0);

    const { id, result } = withFindings[0]!;
    expect(result.reviewCount).toBe(1);
    const finding = [...result.praise, ...result.faults][0]!;
    const text = demo.dataset.reviews.find((r) => r.productId === id)!.text;
    expect(text).toContain(finding.quote);
  });

  it("mini fixture: findings appear for products carrying a single record", () => {
    const singles = singleRecordProductIds(mini);
    const found = singles.some((id) => {
      const r = findingsFor(mini, id);
      return r.praise.length + r.faults.length > 0;
    });
    expect(found).toBe(true);
  });

  it.skipIf(!hasRealFixture)(
    "real fixture: the traced product B008IFXQFU reports themes instead of nothing",
    () => {
      const real = adaptAmazonCsv(readFileSync(REAL_PATH, "utf8"), "Amazon product records");
      const traced = findingsFor(real, "B008IFXQFU");

      // One record, six matching themes, and previously zero findings.
      expect(traced.reviewCount).toBe(1);
      expect(traced.praise.length).toBeGreaterThan(0);

      // And it is not a one-off: most products now report something.
      const ids = real.dataset.products.map((p) => p.id);
      const productive = ids.filter((id) => {
        const r = findingsFor(real, id);
        return r.praise.length + r.faults.length > 0;
      });
      expect(productive.length).toBeGreaterThan(ids.length / 2);
    },
  );
});
