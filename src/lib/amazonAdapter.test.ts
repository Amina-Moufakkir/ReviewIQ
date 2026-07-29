import { describe, it, expect } from "vitest";
import { adaptAmazonCsv } from "./amazonAdapter";
import { CsvError } from "./parseReviews";
import { hasDates, unitFor } from "./datasetInfo";

const HEADER =
  "product_id,product_name,category,discounted_price,actual_price,discount_percentage,rating,rating_count,review_content";

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\n") + "\n";
}

/** A well-formed record; fields can be overridden positionally by the callers. */
const ROW_A =
  'B01,Widget One,"Electronics|Accessories|Cables",₹399,"₹1,099",64%,4.2,"24,269","Charging is fast, and the braid feels solid."';
const ROW_B =
  'B02,Gadget Two,"Home&Kitchen|Appliances",₹199,₹349,43%,3.0,"7,928","Stopped working after a month. Very disappointing."';

describe("adaptAmazonCsv — mapping", () => {
  it("maps Amazon columns onto the canonical loader shape", () => {
    const { dataset, records } = adaptAmazonCsv(csv(ROW_A, ROW_B), "amazon.csv");

    expect(dataset.source).toBe("amazon");
    expect(dataset.label).toBe("amazon.csv");
    expect(dataset.reviews).toHaveLength(2);
    expect(dataset.products.map((p) => p.id).sort()).toEqual(["B01", "B02"]);
    expect(records[0]!.productName).toBe("Widget One");
  });

  it("uses review_content verbatim and never splits it on commas", () => {
    const { dataset } = adaptAmazonCsv(csv(ROW_A), "f.csv");
    // One record in, one review out — the commas inside the cell are text,
    // not review boundaries.
    expect(dataset.reviews).toHaveLength(1);
    expect(dataset.reviews[0]!.text).toBe("Charging is fast, and the braid feels solid.");
  });

  it("gives each record a stable synthetic id from its source row number", () => {
    const { dataset } = adaptAmazonCsv(csv(ROW_A, ROW_B), "f.csv");
    expect(dataset.reviews.map((r) => r.id)).toEqual(["amz-0001", "amz-0002"]);
  });

  it("splits the category hierarchy, keeping the leaf and the full path", () => {
    const { dataset, records } = adaptAmazonCsv(csv(ROW_A), "f.csv");
    expect(records[0]!.categoryPath).toEqual(["Electronics", "Accessories", "Cables"]);
    expect(records[0]!.category).toBe("Cables");
    expect(records[0]!.raw.category).toBe("Electronics|Accessories|Cables");
    expect(dataset.reviews[0]!.category).toBe("Cables");
    expect(dataset.products[0]!.category).toBe("Cables");
  });
});

describe("adaptAmazonCsv — normalization", () => {
  it("rounds the product-average rating and preserves the source decimal", () => {
    const { dataset, records } = adaptAmazonCsv(csv(ROW_A), "f.csv");
    // A compatibility transformation, not a claim the average was an integer.
    expect(records[0]!.sourceRating).toBe(4.2);
    expect(records[0]!.rating).toBe(4);
    expect(dataset.reviews[0]!.rating).toBe(4);
    expect(dataset.reviews[0]!.sourceRating).toBe(4.2);
  });

  it("rounds half-way ratings up, consistently with Math.round", () => {
    const { records } = adaptAmazonCsv(
      csv('B01,W,Cat,₹1,₹2,50%,3.5,"10","text"', 'B02,W2,Cat,₹1,₹2,50%,2.4,"10","text"'),
      "f.csv",
    );
    expect(records.map((r) => [r.sourceRating, r.rating])).toEqual([
      [3.5, 4],
      [2.4, 2],
    ]);
  });

  it("strips ₹, thousands separators and % while keeping the raw strings", () => {
    const { records } = adaptAmazonCsv(csv(ROW_A), "f.csv");
    const rec = records[0]!;
    expect(rec.discountedPrice).toBe(399);
    expect(rec.actualPrice).toBe(1099);
    expect(rec.discountPercent).toBe(64);
    expect(rec.ratingCount).toBe(24269);
    expect(rec.raw).toMatchObject({
      discounted_price: "₹399",
      actual_price: "₹1,099",
      discount_percentage: "64%",
      rating: "4.2",
      rating_count: "24,269",
    });
  });

  it("leaves an unparseable informational value undefined without dropping the record", () => {
    const { dataset, records, stats } = adaptAmazonCsv(
      csv('B01,W,Cat,₹399,₹1099,64%,4.2,,"text"'),
      "f.csv",
    );
    expect(stats.skipped).toBe(0);
    expect(dataset.reviews).toHaveLength(1);
    expect(records[0]!.ratingCount).toBeUndefined();
    expect(records[0]!.raw.rating_count).toBe("");
  });

  it("does not treat the listing discount as a purchase promotion", () => {
    // discount_percentage is a listing discount, not a promotion the reviewer
    // bought under, so it never reaches Review.discountPercent.
    const { dataset } = adaptAmazonCsv(csv(ROW_A), "f.csv");
    expect(dataset.reviews[0]!.discountPercent).toBeUndefined();
    expect(dataset.reviews[0]!.promotion).toBeUndefined();
  });
});

describe("adaptAmazonCsv — dates", () => {
  it("produces undated reviews rather than inventing a date", () => {
    const { dataset } = adaptAmazonCsv(csv(ROW_A, ROW_B), "f.csv");
    expect(dataset.reviews.every((r) => r.date === "")).toBe(true);
    expect(hasDates(dataset)).toBe(false);
  });

  it("labels its rows as product records, not reviews", () => {
    const { dataset } = adaptAmazonCsv(csv(ROW_A), "f.csv");
    expect(unitFor(dataset)).toMatchObject({ many: "product records", isProductLevel: true });
  });
});

describe("adaptAmazonCsv — skipped records", () => {
  it("skips a record whose rating is not a number, and says why", () => {
    const { dataset, stats } = adaptAmazonCsv(
      csv(ROW_A, 'B09,Broken,Cat,₹1,₹2,10%,|,"992","some text"'),
      "f.csv",
    );
    expect(dataset.reviews).toHaveLength(1);
    expect(stats).toMatchObject({ parsed: 2, accepted: 1, skipped: 1 });
    expect(stats.skipReasons).toEqual({ invalid_rating: 1 });
  });

  it("skips records missing a product id or review text", () => {
    const { stats } = adaptAmazonCsv(
      csv(
        ROW_A,
        ',No id,Cat,₹1,₹2,10%,4.0,"10","text"',
        'B10,No text,Cat,₹1,₹2,10%,4.0,"10",""',
        'B11,Out of range,Cat,₹1,₹2,10%,0.2,"10","text"',
      ),
      "f.csv",
    );
    expect(stats).toMatchObject({ parsed: 4, accepted: 1, skipped: 3 });
    expect(stats.skipReasons).toEqual({
      missing_product_id: 1,
      missing_review_text: 1,
      invalid_rating: 1,
    });
  });

  it("keeps accepted + skipped === parsed, with reasons summing to skipped", () => {
    const { stats } = adaptAmazonCsv(
      csv(ROW_A, 'B09,Broken,Cat,₹1,₹2,10%,|,"992","text"', ROW_B),
      "f.csv",
    );
    expect(stats.accepted + stats.skipped).toBe(stats.parsed);
    const reasonTotal = Object.values(stats.skipReasons).reduce<number>(
      (sum, n) => sum + (n ?? 0),
      0,
    );
    expect(reasonTotal).toBe(stats.skipped);
  });

  it("throws when the file is unusable", () => {
    expect(() => adaptAmazonCsv("", "f.csv")).toThrow(CsvError);
    expect(() => adaptAmazonCsv("product_id,rating\nB01,4.2\n", "f.csv")).toThrow(
      /missing required column/i,
    );
    expect(() => adaptAmazonCsv(csv('B09,B,Cat,₹1,₹2,10%,|,"1","t"'), "f.csv")).toThrow(CsvError);
  });
});

describe("adaptAmazonCsv — rating filter", () => {
  const RATINGS = csv(
    'B01,A,Cat,₹1,₹2,10%,2.0,"10","text a"',
    'B02,B,Cat,₹1,₹2,10%,3.4,"10","text b"',
    'B03,C,Cat,₹1,₹2,10%,3.5,"10","text c"',
    'B04,D,Cat,₹1,₹2,10%,4.2,"10","text d"',
    'B05,E,Cat,₹1,₹2,10%,|,"10","text e"',
  );

  it("filters on the source rating, excluding >= 3.5 and anything invalid", () => {
    const { records, stats } = adaptAmazonCsv(RATINGS, "f.csv");
    const low = records.filter((r) => r.sourceRating < 3.5);

    expect(low.every((r) => r.sourceRating < 3.5)).toBe(true);
    expect(low.map((r) => r.productId)).toEqual(["B01", "B02"]);
    // >= 3.5 excluded, and the invalid rating never became a record at all.
    expect(records.some((r) => r.sourceRating >= 3.5)).toBe(true);
    expect(low.some((r) => r.productId === "B05")).toBe(false);
    expect(records.every((r) => Number.isFinite(r.sourceRating))).toBe(true);
    expect(stats.skipReasons).toEqual({ invalid_rating: 1 });
  });

  it("shows why the source decimal is preserved: rounding shifts the engine's threshold", () => {
    // The heuristic engine treats rating >= 4 as praise evidence. Rounding
    // promotes every 3.5–3.99 average into that bucket, so questions about the
    // real distribution must be asked of sourceRating, not rating.
    const { records } = adaptAmazonCsv(RATINGS, "f.csv");
    const praiseByRounded = records.filter((r) => r.rating >= 4).map((r) => r.productId);
    const praiseBySource = records.filter((r) => r.sourceRating >= 4).map((r) => r.productId);
    expect(praiseByRounded).toEqual(["B03", "B04"]);
    expect(praiseBySource).toEqual(["B04"]);
  });
});
