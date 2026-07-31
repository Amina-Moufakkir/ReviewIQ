import { describe, it, expect } from "vitest";
import type { AnalysisInput, Product, Review } from "../types";
import { validateTags, type RawTag } from "./claudeTags";
import { tagsToResult } from "./tagsToResult";
import { PRODUCT_RECORD } from "../lib/datasetInfo";

const PRODUCT: Product = { id: "p1", name: "Test Widget", category: "Electronics", topCategory: "Electronics" };
const INPUT: AnalysisInput = { productId: "p1", from: "2026-01-01", to: "2026-12-31" };

function review(id: string, text: string, author: string): Review {
  return { id, productId: "p1", date: "2026-02-01", rating: 5, text, author };
}

/** Validate raw tags against the matched reviews, then assemble a result. */
function analyze(matched: Review[], raw: RawTag[]) {
  const reviewsById = new Map(matched.map((r) => [r.id, r.text] as const));
  const { valid } = validateTags(raw, reviewsById);
  return tagsToResult(INPUT, PRODUCT, matched, valid);
}

describe("tagsToResult", () => {
  it("computes percent using the total number of selected reviews as denominator", () => {
    const matched = [
      review("r1", "Very comfortable to wear.", "A"),
      review("r2", "So comfortable for long days.", "B"),
      review("r3", "Arrived on time.", "C"),
      review("r4", "Nice packaging.", "D"),
    ];
    const raw: RawTag[] = [
      { review_id: "r1", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable to wear" },
      { review_id: "r2", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable for long days" },
    ];
    const result = analyze(matched, raw);
    const comfort = result.praise.find((f) => f.label === "Comfort");
    expect(result.reviewCount).toBe(4);
    expect(comfort?.mentions).toBe(2);
    expect(comfort?.percent).toBe(50); // 2 of 4, not 2 of 2
  });

  it("applies the minimum-support threshold on unique same-sentiment reviews", () => {
    const matched = [
      review("r1", "Very comfortable.", "A"),
      review("r2", "Arrived quickly.", "B"),
    ];
    const raw: RawTag[] = [
      { review_id: "r1", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable" },
    ];
    const result = analyze(matched, raw);
    // Only one supporting review — below MIN_EVIDENCE — so no finding.
    expect(result.praise.find((f) => f.label === "Comfort")).toBeUndefined();
  });

  it("counts a review at most once per theme-sentiment pair", () => {
    const matched = [
      review("r1", "Comfortable and the fit is comfortable too.", "A"),
      review("r2", "Very comfortable overall.", "B"),
    ];
    // r1 is tagged twice for the same theme+sentiment (two real spans).
    const raw: RawTag[] = [
      { review_id: "r1", theme: "Comfort", sentiment: "praise", evidence_span: "Comfortable and the fit" },
      { review_id: "r1", theme: "Comfort", sentiment: "praise", evidence_span: "the fit is comfortable too" },
      { review_id: "r2", theme: "Comfort", sentiment: "praise", evidence_span: "Very comfortable overall" },
    ];
    const result = analyze(matched, raw);
    const comfort = result.praise.find((f) => f.label === "Comfort");
    expect(comfort?.mentions).toBe(2); // r1 counts once, plus r2 — not 3
  });

  it("lets one review appear as praise for one theme and fault for another", () => {
    const matched = [
      review("r1", "Battery lasts for days but the sound is tinny.", "A"),
      review("r2", "Battery easily lasts a day.", "B"),
      review("r3", "The sound is tinny and hollow.", "C"),
    ];
    const raw: RawTag[] = [
      { review_id: "r1", theme: "Battery", sentiment: "praise", evidence_span: "Battery lasts for days" },
      { review_id: "r2", theme: "Battery", sentiment: "praise", evidence_span: "Battery easily lasts a day" },
      { review_id: "r1", theme: "Sound", sentiment: "fault", evidence_span: "the sound is tinny" },
      { review_id: "r3", theme: "Sound", sentiment: "fault", evidence_span: "The sound is tinny and hollow" },
    ];
    const result = analyze(matched, raw);
    expect(result.praise.some((f) => f.label === "Battery")).toBe(true);
    expect(result.faults.some((f) => f.label === "Sound")).toBe(true);
  });

  it("takes the representative quote from a validated evidence span and attributes it", () => {
    const matched = [
      review("r1", "Very comfortable to wear.", "Priya N."),
      review("r2", "So comfortable for long days.", "Chris M."),
    ];
    const raw: RawTag[] = [
      { review_id: "r1", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable to wear" },
      { review_id: "r2", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable for long days" },
    ];
    const comfort = analyze(matched, raw).praise.find((f) => f.label === "Comfort")!;
    expect(comfort.quote).toBe("comfortable to wear"); // earliest matched review
    expect(comfort.quoteAuthor).toBe("Priya N.");
  });

  it("derives one recommendation per fault, from the theme and its support count", () => {
    const matched = [
      review("r1", "The sound is tinny.", "A"),
      review("r2", "Tinny sound throughout.", "B"),
    ];
    const raw: RawTag[] = [
      { review_id: "r1", theme: "Sound", sentiment: "fault", evidence_span: "The sound is tinny" },
      { review_id: "r2", theme: "Sound", sentiment: "fault", evidence_span: "Tinny sound throughout" },
    ];
    const result = analyze(matched, raw);
    expect(result.faults.some((f) => f.label === "Sound")).toBe(true);
    expect(result.recommendations).toEqual(["Investigate sound — raised in 2 of 2 reviews."]);
  });

  it("recommends nothing when there are no faults, however much praise there is", () => {
    const matched = [
      review("r1", "Very comfortable to wear.", "A"),
      review("r2", "So comfortable for long days.", "B"),
    ];
    const raw: RawTag[] = [
      { review_id: "r1", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable to wear" },
      { review_id: "r2", theme: "Comfort", sentiment: "praise", evidence_span: "comfortable for long days" },
    ];
    const result = analyze(matched, raw);
    expect(result.praise).toHaveLength(1);
    expect(result.recommendations).toEqual([]);
  });

  // Actions must lead with the complaint an analyst can most defend, which is
  // the one the most reviews support — the same order the fault column uses.
  it("orders recommendations by support, strongest first", () => {
    // Sound has 3 supporting reviews, Rattle 2. "Rattle" sorts first
    // alphabetically, so equal support would put it on top — support must win.
    const matched = [
      review("r1", "The sound is tinny and it rattles.", "A"),
      review("r2", "Tinny sound throughout.", "B"),
      review("r3", "It rattles a bit.", "C"),
      review("r4", "Sound is poor at volume.", "D"),
    ];
    const raw: RawTag[] = [
      { review_id: "r1", theme: "Sound", sentiment: "fault", evidence_span: "The sound is tinny" },
      { review_id: "r2", theme: "Sound", sentiment: "fault", evidence_span: "Tinny sound throughout" },
      { review_id: "r4", theme: "Sound", sentiment: "fault", evidence_span: "Sound is poor at volume" },
      { review_id: "r1", theme: "Rattle", sentiment: "fault", evidence_span: "it rattles" },
      { review_id: "r3", theme: "Rattle", sentiment: "fault", evidence_span: "It rattles a bit" },
    ];
    const result = analyze(matched, raw);
    expect(result.recommendations).toEqual([
      "Investigate sound — raised in 3 of 4 reviews.",
      "Investigate rattle — raised in 2 of 4 reviews.",
    ]);
  });

  // One product record bundles many customers, so "1 of 1 · 100%" would read as
  // unanimity. The action names where the complaint was found instead.
  it("names the row instead of a tally when a single product record is analyzed", () => {
    const matched = [review("r1", "The base wobbles on an uneven desk.", "A")];
    const raw: RawTag[] = [
      { review_id: "r1", theme: "Wobbly base", sentiment: "fault", evidence_span: "The base wobbles" },
    ];
    const reviewsById = new Map(matched.map((r) => [r.id, r.text] as const));
    const { valid } = validateTags(raw, reviewsById);
    const result = tagsToResult(INPUT, PRODUCT, matched, valid, PRODUCT_RECORD);
    expect(result.recommendations).toEqual([
      "Investigate wobbly base — raised in the selected product record.",
    ]);
  });
});

/**
 * Both engines must agree on what counts as evidence, or switching engines
 * would silently change which themes survive. The Claude path takes the same
 * per-unit threshold as the heuristic one.
 */
describe("tagsToResult — evidence threshold follows the dataset unit", () => {
  const one = [review("r1", "The sound quality is superb.", "Ann")];
  const raw: RawTag[] = [
    { review_id: "r1", theme: "Sound quality", sentiment: "praise", evidence_span: "sound quality is superb" },
  ];

  function build(unit?: typeof PRODUCT_RECORD) {
    const reviewsById = new Map(one.map((r) => [r.id, r.text] as const));
    const { valid } = validateTags(raw, reviewsById);
    return unit
      ? tagsToResult(INPUT, PRODUCT, one, valid, unit)
      : tagsToResult(INPUT, PRODUCT, one, valid);
  }

  it("drops a single-review theme for review data", () => {
    expect(build().praise).toHaveLength(0);
  });

  it("keeps a single-record theme for product-level data", () => {
    const result = build(PRODUCT_RECORD);
    expect(result.praise).toHaveLength(1);
    expect(result.praise[0]!.mentions).toBe(1);
  });
});
