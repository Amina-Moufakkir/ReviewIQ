import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { loadUploadedCsv } from "./loadUploadedCsv";
import { adaptAmazonCsv } from "./amazonAdapter";
import { parseReviewsCsv, CsvError, loadStatsFor } from "./parseReviews";
import { hasDates, unitFor } from "./datasetInfo";
import { stateForQuery, type AnalysisState } from "../hooks/useAnalysis";
import type { AnalysisInput } from "../types";

/**
 * The upload boundary, which routes a file by its header.
 *
 * The reported gap: uploading the raw Amazon export failed with "Missing
 * required column: review_text", because every upload went to the canonical
 * loader and the Amazon adapter was never reached. These tests pin both routes,
 * the rejection of anything matching neither, and the metadata an Amazon upload
 * must report.
 */

const CANONICAL_CSV = [
  "review_id,product_id,product_name,category,review_date,rating,review_text,verified_purchase,country",
  'r1,p1,Aurora Earbuds,Electronics,2026-01-05,5,"Superb sound quality, and the battery lasts.",true,US',
  'r2,p1,Aurora Earbuds,Electronics,2026-01-06,2,"The bluetooth connection drops constantly.",false,UK',
  'r3,p2,Trailpeak Backpack,Outdoor,2026-01-07,4,"Roomy and comfortable on long walks.",true,CA',
].join("\n");

/** The raw Amazon export's shape: 16 columns, review_content, no review_text. */
const RAW_AMAZON_CSV = [
  "product_id,product_name,category,discounted_price,actual_price,discount_percentage,rating,rating_count,about_product,user_id,user_name,review_id,review_title,review_content,img_link,product_link",
  'B01,"Fast Charging Cable, 2m",Computers&Accessories|Cables,"₹199","₹499",60%,4.2,"12,345",Marketing copy,"AG1,AG2","Ann,Bob","R1,R2","Good,Fine","Charges fast and the cable feels sturdy.",http://img,http://prod',
  'B02,"Mixer Grinder 750W",Home&Kitchen|Appliances|Mixers,"₹2,499","₹4,999",50%,3.9,"6,789",Marketing copy,"AG3","Cal","R3","Ok","Grinds well but the jar leaks a little.",http://img,http://prod',
  'B01,"Fast Charging Cable, 2m (White)",Computers&Accessories|Cables,"₹210","₹499",58%,4.4,"1,111",Marketing copy,"AG4","Dee","R4","Nice","Second listing for the same product id.",http://img,http://prod',
  'B03,"Broken Row",Home&Kitchen|Appliances,"₹99","₹199",50%,|,"1",Marketing copy,"AG5","Eve","R5","Bad","Rating cell is a pipe, so this row is skipped.",http://img,http://prod',
].join("\n");

const RAW_PATH = new URL("../amazon.csv", import.meta.url);

describe("upload routing — canonical ReviewIQ CSV", () => {
  it("loads unchanged: identical to what the canonical loader produces directly", () => {
    const viaUpload = loadUploadedCsv(CANONICAL_CSV, "reviews.csv");
    const direct = parseReviewsCsv(CANONICAL_CSV, "reviews.csv");

    expect(viaUpload.dataset).toEqual(direct.dataset);
    expect(viaUpload.stats).toEqual(loadStatsFor(direct));
    expect(viaUpload.dataset.source).toBe("uploaded");
  });

  it("keeps review-level semantics: reviews, dated, one row per customer", () => {
    const { dataset, stats } = loadUploadedCsv(CANONICAL_CSV, "reviews.csv");

    expect(stats).toMatchObject({ parsed: 3, accepted: 3, skipped: 0 });
    expect(dataset.products).toHaveLength(2);
    expect(unitFor(dataset).many).toBe("reviews");
    expect(hasDates(dataset)).toBe(true);
    expect(dataset.reviews[0]!.date).toBe("2026-01-05");
  });

  it("still rejects a canonical file's own bad rows the same way", () => {
    const withBadRow = `${CANONICAL_CSV}\nr4,p1,Aurora Earbuds,Electronics,2026-13-99,4,"Impossible date.",true,US`;
    const { stats } = loadUploadedCsv(withBadRow, "reviews.csv");
    expect(stats).toMatchObject({ parsed: 4, accepted: 3, skipped: 1 });
    expect(stats.skipReasons).toMatchObject({ invalid_date: 1 });
  });
});

describe("upload routing — raw Amazon export", () => {
  it("routes through the Amazon adapter instead of failing on review_text", () => {
    // The exact failure reported from production.
    expect(() => parseReviewsCsv(RAW_AMAZON_CSV, "amazon.csv")).toThrow(/review_text/);

    const { dataset } = loadUploadedCsv(RAW_AMAZON_CSV, "amazon.csv");
    expect(dataset.source).toBe("amazon");
  });

  it("produces exactly what the Amazon adapter produces for the same bytes", () => {
    const viaUpload = loadUploadedCsv(RAW_AMAZON_CSV, "amazon.csv");
    const direct = adaptAmazonCsv(RAW_AMAZON_CSV, "amazon.csv");

    expect(viaUpload.dataset).toEqual(direct.dataset);
    expect(viaUpload.stats).toEqual(direct.stats);
  });

  it("reports parsed / accepted / skipped, products, dates and unit correctly", () => {
    const { dataset, stats } = loadUploadedCsv(RAW_AMAZON_CSV, "amazon.csv");

    // 4 data rows: 3 accepted, 1 skipped for the "|" rating cell.
    expect(stats.parsed).toBe(4);
    expect(stats.accepted).toBe(3);
    expect(stats.skipped).toBe(1);
    expect(stats.skipReasons).toMatchObject({ invalid_rating: 1 });
    expect(stats.accepted + stats.skipped).toBe(stats.parsed);

    // B01 appears twice: 3 accepted records, 2 products.
    expect(dataset.products).toHaveLength(2);
    expect(dataset.reviews).toHaveLength(3);

    // Undated, product-level, and labelled with the uploaded file's name.
    expect(hasDates(dataset)).toBe(false);
    expect(dataset.reviews.every((r) => r.date === "")).toBe(true);
    expect(unitFor(dataset)).toMatchObject({ many: "product records", isProductLevel: true });
    expect(dataset.label).toBe("amazon.csv");

    // Adapter transformations survive the route: decimal rating preserved,
    // category leafed, review_content verbatim and never split on its commas.
    const first = dataset.reviews[0]!;
    expect(first.rating).toBe(4);
    expect(first.sourceRating).toBe(4.2);
    expect(first.category).toBe("Cables");
    expect(first.text).toBe("Charges fast and the cable feels sturdy.");
  });

  it.skipIf(!existsSync(RAW_PATH))(
    "routes the real 16-column source file the same way (local dataset only)",
    () => {
      const text = readFileSync(RAW_PATH, "utf8");
      const { dataset, stats } = loadUploadedCsv(text, "amazon.csv");

      expect(dataset.source).toBe("amazon");
      expect(stats.accepted + stats.skipped).toBe(stats.parsed);
      expect(unitFor(dataset).isProductLevel).toBe(true);
      expect(hasDates(dataset)).toBe(false);
      expect(stats).toEqual(adaptAmazonCsv(text, "amazon.csv").stats);
    },
  );
});

describe("upload routing — files matching neither shape", () => {
  it("names what each shape is missing", () => {
    const orders = ["order_id,customer,total", "1,Ann,42.00"].join("\n");
    expect(() => loadUploadedCsv(orders, "orders.csv")).toThrow(CsvError);
    expect(() => loadUploadedCsv(orders, "orders.csv")).toThrow(
      /matches neither supported format.*ReviewIQ review CSV it is missing review_id, product_id.*Amazon product export it is missing product_id.*review_content/s,
    );
  });

  it("rejects a near-miss rather than guessing", () => {
    // Amazon-shaped but for the one column that carries the text.
    const nearMiss = ["product_id,product_name,category,rating", "B01,Cable,Cables,4.2"].join("\n");
    expect(() => loadUploadedCsv(nearMiss, "near.csv")).toThrow(/missing review_content/);
  });

  it("rejects an empty file", () => {
    expect(() => loadUploadedCsv("", "empty.csv")).toThrow(/file is empty/i);
  });

  it("reads a file carrying both text columns as the canonical format", () => {
    const both = [
      "review_id,product_id,product_name,category,rating,review_text,review_content",
      "r1,p1,Widget,Electronics,5,Canonical text wins.,Amazon text ignored.",
    ].join("\n");
    const { dataset } = loadUploadedCsv(both, "both.csv");
    expect(dataset.source).toBe("uploaded");
    expect(dataset.reviews[0]!.text).toBe("Canonical text wins.");
  });
});

/**
 * Switching datasets must clear a previous dataset's report. App does that
 * through the existing query binding: applying a dataset selects its first
 * product, which changes the live query, and stateForQuery hides any result
 * analyzed under the old one. Asserted here on an upload-shaped switch.
 */
describe("upload routing — a dataset switch clears stale analysis", () => {
  it("hides the previous dataset's result once the new dataset's product is selected", () => {
    const reviewDataset = loadUploadedCsv(CANONICAL_CSV, "reviews.csv").dataset;
    const amazonDataset = loadUploadedCsv(RAW_AMAZON_CSV, "amazon.csv").dataset;

    const firstProduct = (d: typeof reviewDataset): AnalysisInput => ({
      scope: { kind: "product", productId: d.products[0]!.id },
      from: "",
      to: "",
    });
    const before = firstProduct(reviewDataset);
    const after = firstProduct(amazonDataset);
    expect(before.scope).not.toEqual(after.scope);

    const analyzed: AnalysisState = {
      status: "success",
      result: {
        productName: reviewDataset.products[0]!.name,
        from: "",
        to: "",
        reviewCount: 2,
        averageRating: 3.5,
        summary: "Across 2 reviews of Aurora Earbuds…",
        praise: [],
        faults: [],
        recommendations: [],
      },
    };

    // Visible while its own query is live…
    expect(stateForQuery(analyzed, before, before)).toBe(analyzed);
    // …and gone the moment the uploaded Amazon dataset's product takes over.
    expect(stateForQuery(analyzed, before, after)).toEqual({ status: "idle" });
  });
});
