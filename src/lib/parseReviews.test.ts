import { describe, it, expect } from "vitest";
import { parseReviewsCsv, loadStatsFor, CsvError } from "./parseReviews";
import { parseCsv } from "./csv";
import { hasDates } from "./datasetInfo";

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

/**
 * `review_date` is optional at the COLUMN level and strictly required at the
 * ROW level whenever that column exists. This is a real behaviour change to the
 * loader, not an Amazon-adapter detail, so it is pinned from both directions:
 * a dated CSV must not get looser, and an undated one must be explicitly
 * undated rather than accidentally accepted.
 */
describe("parseReviewsCsv — dated vs undated datasets", () => {
  const UNDATED_HEADER = "review_id,product_id,product_name,category,rating,review_text";
  const undatedCsv = (...rows: string[]) => [UNDATED_HEADER, ...rows].join("\n") + "\n";

  describe("when the review_date column is present", () => {
    it("still rejects invalid dates by the original rules", () => {
      const text = csv(
        "r1,p1,Widget,Electronics,2026-01-05,5,ok,Valid,true,US",
        "r2,p1,Widget,Electronics,not-a-date,4,ok,Malformed,true,US",
        "r3,p1,Widget,Electronics,2026-02-30,4,ok,Impossible day,true,US",
        "r4,p1,Widget,Electronics,2026-13-01,4,ok,Impossible month,true,US",
        "r5,p1,Widget,Electronics,2025-02-29,4,ok,Non-leap Feb 29,true,US",
        "r6,p1,Widget,Electronics,05/01/2026,4,ok,Wrong format,true,US",
      );
      const { dataset, skipped, skipReasons } = parseReviewsCsv(text, "f.csv");
      expect(dataset.reviews.map((r) => r.id)).toEqual(["r1"]);
      expect(skipped).toBe(5);
      expect(skipReasons).toEqual({ invalid_date: 5 });
    });

    it("rejects a BLANK date rather than treating the row as undated", () => {
      const text = csv(
        "r1,p1,Widget,Electronics,2026-01-05,5,ok,Dated,true,US",
        "r2,p1,Widget,Electronics,,4,ok,Blank date,true,US",
        "r3,p1,Widget,Electronics,   ,4,ok,Whitespace date,true,US",
      );
      const { dataset, skipped, skipReasons } = parseReviewsCsv(text, "f.csv");
      expect(dataset.reviews.map((r) => r.id)).toEqual(["r1"]);
      expect(skipped).toBe(2);
      expect(skipReasons).toEqual({ invalid_date: 2 });
      // No row slipped through with an empty date, so the dataset is still dated.
      expect(dataset.reviews.every((r) => r.date !== "")).toBe(true);
      expect(hasDates(dataset)).toBe(true);
    });

    it("throws when every row's date is blank — it never becomes undated", () => {
      const text = csv(
        "r1,p1,Widget,Electronics,,5,ok,Blank,true,US",
        "r2,p1,Widget,Electronics,,4,ok,Blank,true,US",
      );
      expect(() => parseReviewsCsv(text, "f.csv")).toThrow(/no valid review rows/i);
    });
  });

  describe("when the review_date column is absent", () => {
    it("loads the dataset as explicitly undated", () => {
      const { dataset, skipped, skipReasons } = parseReviewsCsv(
        undatedCsv("r1,p1,Widget,Electronics,5,Good sound", "r2,p1,Widget,Electronics,2,Bad sound"),
        "f.csv",
      );
      expect(skipped).toBe(0);
      expect(skipReasons).toEqual({});
      expect(dataset.reviews.map((r) => r.date)).toEqual(["", ""]);
      expect(hasDates(dataset)).toBe(false);
    });

    it("still enforces every other row rule", () => {
      const { dataset, skipped, skipReasons } = parseReviewsCsv(
        undatedCsv(
          "r1,p1,Widget,Electronics,5,Fine",
          "r1,p1,Widget,Electronics,4,Duplicate id",
          ",p1,Widget,Electronics,4,No id",
          "r4,,Widget,Electronics,4,No product",
          "r5,p1,Widget,Electronics,9,Bad rating",
          "r6,p1,Widget,Electronics,4,",
        ),
        "f.csv",
      );
      expect(dataset.reviews.map((r) => r.id)).toEqual(["r1"]);
      expect(skipped).toBe(5);
      expect(skipReasons).toEqual({
        duplicate_review_id: 1,
        missing_review_id: 1,
        missing_product_id: 1,
        invalid_rating: 1,
        missing_review_text: 1,
      });
    });

    it("is all-or-nothing: no row can carry a date the dataset does not have", () => {
      // A stray review_date VALUE cannot leak in without the column: the loader
      // reads dates by column name, so an undated dataset is uniformly undated
      // and the empty window cannot silently exclude anyone.
      const { dataset } = parseReviewsCsv(
        undatedCsv("r1,p1,Widget,Electronics,5,Text one", "r2,p2,Gadget,Wearables,4,Text two"),
        "f.csv",
      );
      expect(new Set(dataset.reviews.map((r) => r.date))).toEqual(new Set([""]));
    });
  });

  it("reports parsed = accepted + skipped for either shape", () => {
    const dated = loadStatsFor(
      parseReviewsCsv(
        csv(
          "r1,p1,Widget,Electronics,2026-01-05,5,ok,Kept,true,US",
          "r2,p1,Widget,Electronics,,4,ok,Dropped,true,US",
        ),
        "f.csv",
      ),
    );
    expect(dated).toMatchObject({ parsed: 2, accepted: 1, skipped: 1 });

    const undated = loadStatsFor(
      parseReviewsCsv(undatedCsv("r1,p1,Widget,Electronics,5,Kept"), "f.csv"),
    );
    expect(undated).toMatchObject({ parsed: 1, accepted: 1, skipped: 0 });
  });
});

describe("hasDates", () => {
  const review = (id: string, date: string) => ({
    id,
    productId: "p1",
    date,
    rating: 4,
    text: "text",
  });

  it("is false for an empty dataset", () => {
    expect(hasDates({ products: [], reviews: [], source: "amazon", label: "x" })).toBe(false);
  });

  it("treats a mixed dataset as undated, so no dated row is silently excluded", () => {
    // The loader cannot produce this shape — the guard exists so that if some
    // future source ever did, the app degrades to "no window" rather than
    // filtering dated rows out against an empty range.
    const mixed = {
      products: [],
      reviews: [review("a", "2026-01-05"), review("b", "")],
      source: "uploaded" as const,
      label: "x",
    };
    expect(hasDates(mixed)).toBe(false);
  });

  it("is true only when every review has a date", () => {
    const dated = {
      products: [],
      reviews: [review("a", "2026-01-05"), review("b", "2026-02-05")],
      source: "uploaded" as const,
      label: "x",
    };
    expect(hasDates(dated)).toBe(true);
  });
});
