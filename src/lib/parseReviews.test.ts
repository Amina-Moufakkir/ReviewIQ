import { describe, it, expect } from "vitest";
import { parseReviewsCsv, CsvError } from "./parseReviews";
import { parseCsv } from "./csv";

const HEADER =
  "review_id,product_id,product_name,category,review_date,rating,review_title,review_text,verified_purchase,country";

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\n") + "\n";
}

describe("parseCsv", () => {
  it("handles quoted fields with commas and escaped quotes", () => {
    const rows = parseCsv('a,b,c\n1,"x, y","she said ""hi"""\n');
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "x, y", 'she said "hi"'],
    ]);
  });

  it("skips blank lines", () => {
    expect(parseCsv("a,b\n\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseReviewsCsv — valid data", () => {
  it("maps rows to reviews and derives products", () => {
    const text = csv(
      "r1,p1,Widget One,Electronics,2026-01-05,5,Great,Love the sound,true,US",
      "r2,p1,Widget One,Electronics,2026-02-05,2,Meh,Connection drops,false,UK",
      "r3,p2,Gadget Two,Wearables,2026-03-05,4,Good,Solid battery,true,CA",
    );
    const { dataset, skipped } = parseReviewsCsv(text, "reviews.csv");
    expect(skipped).toBe(0);
    expect(dataset.source).toBe("uploaded");
    expect(dataset.label).toBe("reviews.csv");
    expect(dataset.reviews).toHaveLength(3);
    expect(dataset.products.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    const r1 = dataset.reviews.find((r) => r.id === "r1");
    expect(r1).toMatchObject({ productId: "p1", rating: 5, country: "US", verifiedPurchase: true });
  });

  it("preserves commas inside quoted review text", () => {
    const text = csv('r1,p1,Widget,Electronics,2026-01-05,5,Nice,"Great sound, clear highs, deep bass",true,US');
    const { dataset } = parseReviewsCsv(text, "f.csv");
    expect(dataset.reviews[0]!.text).toBe("Great sound, clear highs, deep bass");
  });
});

describe("parseReviewsCsv — optional promotion columns", () => {
  const PROMO_HEADER =
    "review_id,product_id,product_name,category,review_date,rating,review_text,promotion,discount_percent";
  const promoCsv = (...rows: string[]) => [PROMO_HEADER, ...rows].join("\n") + "\n";

  it("reads promotion label and discount percent when present", () => {
    const text = promoCsv(
      "r1,p1,Widget,Electronics,2026-01-05,5,Great,Spring Sale,20",
      "r2,p1,Widget,Electronics,2026-02-05,4,Fine,,",
    );
    const { dataset } = parseReviewsCsv(text, "f.csv");
    const r1 = dataset.reviews.find((r) => r.id === "r1")!;
    const r2 = dataset.reviews.find((r) => r.id === "r2")!;
    expect(r1.promotion).toBe("Spring Sale");
    expect(r1.discountPercent).toBe(20);
    // Blank promotion cells become undefined (full-price purchase).
    expect(r2.promotion).toBeUndefined();
    expect(r2.discountPercent).toBeUndefined();
  });

  it("ignores an out-of-range or malformed discount without dropping the row", () => {
    const text = promoCsv(
      "r1,p1,Widget,Electronics,2026-01-05,5,Great,Sale,150",
      "r2,p1,Widget,Electronics,2026-02-05,4,Fine,Sale,abc",
    );
    const { dataset, skipped } = parseReviewsCsv(text, "f.csv");
    expect(skipped).toBe(0);
    expect(dataset.reviews.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(dataset.reviews[0]!.discountPercent).toBeUndefined();
    expect(dataset.reviews[1]!.discountPercent).toBeUndefined();
  });

  it("leaves promotion fields undefined when the columns are absent", () => {
    // The standard HEADER has no promotion columns — this is the degrade path.
    const { dataset } = parseReviewsCsv(
      csv("r1,p1,Widget,Electronics,2026-01-05,5,ok,Good sound,true,US"),
      "f.csv",
    );
    expect(dataset.reviews[0]!.promotion).toBeUndefined();
    expect(dataset.reviews[0]!.discountPercent).toBeUndefined();
  });
});

describe("parseReviewsCsv — validation", () => {
  it("throws when a required column is missing", () => {
    const bad = "review_id,product_id,review_date,rating,review_text\nr1,p1,2026-01-05,5,hi\n";
    expect(() => parseReviewsCsv(bad, "f.csv")).toThrow(CsvError);
    expect(() => parseReviewsCsv(bad, "f.csv")).toThrow(/product_name|category/);
  });

  it("skips rows with invalid rating or date, keeping valid ones", () => {
    const text = csv(
      "r1,p1,Widget,Electronics,2026-01-05,5,ok,Good sound,true,US",
      "r2,p1,Widget,Electronics,not-a-date,4,ok,Bad date,true,US",
      "r3,p1,Widget,Electronics,2026-02-05,9,ok,Bad rating,true,US",
      "r4,p1,Widget,Electronics,2026-03-05,3,ok,Fine,true,US",
    );
    const { dataset, skipped } = parseReviewsCsv(text, "f.csv");
    expect(dataset.reviews.map((r) => r.id)).toEqual(["r1", "r4"]);
    expect(skipped).toBe(2);
  });

  it("skips duplicate review_ids", () => {
    const text = csv(
      "r1,p1,Widget,Electronics,2026-01-05,5,ok,First,true,US",
      "r1,p1,Widget,Electronics,2026-02-05,4,ok,Duplicate id,true,US",
    );
    const { dataset, skipped } = parseReviewsCsv(text, "f.csv");
    expect(dataset.reviews).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it("skips rows with impossible calendar dates, keeping valid ones", () => {
    const text = csv(
      "r1,p1,Widget,Electronics,2026-02-28,5,ok,Valid,true,US",
      "r2,p1,Widget,Electronics,2026-02-30,4,ok,Impossible day,true,US",
      "r3,p1,Widget,Electronics,2026-13-01,4,ok,Bad month,true,US",
      "r4,p1,Widget,Electronics,2024-02-29,5,ok,Leap day valid,true,US",
    );
    const { dataset, skipped } = parseReviewsCsv(text, "f.csv");
    expect(dataset.reviews.map((r) => r.id)).toEqual(["r1", "r4"]);
    expect(skipped).toBe(2);
  });

  it("throws when no valid rows remain (all dates impossible)", () => {
    const text = csv(
      "r1,p1,Widget,Electronics,2026-02-30,5,ok,nope,true,US",
      "r2,p1,Widget,Electronics,2026-00-10,5,ok,nope,true,US",
    );
    expect(() => parseReviewsCsv(text, "f.csv")).toThrow(/no valid review rows/i);
  });

  it("throws when no valid rows remain", () => {
    const text = csv("r1,p1,Widget,Electronics,bad,9,ok,nope,true,US");
    expect(() => parseReviewsCsv(text, "f.csv")).toThrow(/no valid review rows/i);
  });
});
